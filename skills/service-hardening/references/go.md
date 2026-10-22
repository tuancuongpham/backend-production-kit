# Same checklist in Go (net/http)

Not covered by the kit's automated tests. It's here so the skill stays useful in Go services; verify it with the same scenarios as `verify/tests/skills/service-hardening.test.ts` (in-flight requests finish during SIGTERM, 503 beyond the concurrency cap, client disconnect cancels `r.Context()`).

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

// Load shedding: a buffered channel as a semaphore. Non-blocking acquire → immediate 503.
func limitInFlight(max int, next http.Handler) http.Handler {
	sem := make(chan struct{}, max)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
			next.ServeHTTP(w, r)
		default:
			w.Header().Set("Retry-After", "1")
			http.Error(w, "overloaded", http.StatusServiceUnavailable)
		}
	})
}

func main() {
	var draining atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/livez", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if draining.Load() /* || !depsHealthy() */ {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ready"))
	})
	mux.HandleFunc("/work", func(w http.ResponseWriter, r *http.Request) {
		// r.Context() is cancelled when the client disconnects: pass it to DB/HTTP/LLM calls.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		_ = ctx
		w.Write([]byte("done"))
	})

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           limitInFlight(256, mux),
		ReadHeaderTimeout: 10 * time.Second, // slowloris
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second, // streaming endpoints: use http.ResponseController per request instead
		IdleTimeout:       65 * time.Second, // > LB idle timeout
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
		}
	}()

	<-ctx.Done()
	draining.Store(true)          // 1. readiness → 503; requests that still arrive are served...
	srv.SetKeepAlivesEnabled(false) // ...and their connections closed, so the next request goes elsewhere
	time.Sleep(5 * time.Second)   // 2. let the LB notice
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil { // 3+4. stop accepting, wait for in-flight
		slog.Warn("forced shutdown", "err", err)
		srv.Close() // 5. cut stragglers
	}
	// 6. close DB pools, flush telemetry here
}
```

Notes:
- `srv.Shutdown` doesn't wait for hijacked connections (WebSockets). Track and close them yourself (`RegisterOnShutdown`).
- 10k+ concurrent connections are routine for Go and Node alike. The limits that matter are file descriptors (`ulimit -n`), memory per connection, and downstream pools. Load-test with `k6` or `wrk` and watch those.
