<div align="center">

[English](../../README.md) · **Tiếng Việt**

# backend-production-kit

### Bộ skill giúp AI agent viết backend đạt chuẩn production.

**Cùng một agent, cùng một yêu cầu: có bộ kit thì đạt 100% các tiêu chí production; không có thì đạt 66%.**

[![CI](https://img.shields.io/github/actions/workflow/status/tuancuongpham/backend-production-kit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tuancuongpham/backend-production-kit/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/tuancuongpham/backend-production-kit?style=flat-square&color=2f81f7)](https://github.com/tuancuongpham/backend-production-kit/releases/latest)
[![Node 24](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat-square&logo=node.js&logoColor=white)](#bắt-đầu-nhanh)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)

</div>

AI agent viết được code backend *chạy được*. Thứ nó bỏ sót là những phần chỉ hỏng khi lên production: role
database của chatbot đọc được số điện thoại của mọi khách hàng, webhook cộng tiền hai lần, ngân sách LLM bị các
request đồng thời vượt qua dễ dàng. Mỗi skill trong bộ này trang bị cho agent các quyết định cần đưa ra, code mẫu
và test cho đúng một mảng như vậy. Khác biệt thể hiện ngay trong thứ agent giao ra.

## Có và không có bộ kit

Chúng tôi giao cho cùng một agent (Claude Opus 5.5) sáu bài backend thực tế, mỗi bài làm một lần có skill tương
ứng và một lần không có. Code được các grader độc lập chấm theo 57 tiêu chí production
([phương pháp và giới hạn](../evaluation.md)).

| Bài | Không có bộ kit, agent giao ra… | Có bộ kit, agent giao ra… |
|---|---|---|
| **Chatbot CSKH đọc đơn hàng từ Postgres** | role DB đọc được **SĐT, email và họ tên thô của mọi khách**; lọc dữ liệu chỉ bằng `WHERE` trong code app; tra cứu cho khách vãng lai bằng số điện thoại do model trích từ đoạn chat, **bật sẵn** | role chỉ đọc được các view đã che PII; lọc dữ liệu **ngay trong Postgres** bằng một tham số chỉ server mới đặt được; có test chứng minh lệnh ghi bị từ chối (*permission denied*) |
| **"Cứ để LLM tự viết SQL"** | một dòng cảnh báo chung chung, và test "read-only" chạy trên hai kết nối khác nhau (**không chứng minh được gì**) | giải thích đúng rủi ro (SQL của model có thể tắt `read_only`, gọi `set_config`), có parser chặn các lệnh đó, thu hồi `CREATE`/`TEMP`, đề xuất phương án named tool an toàn hơn |
| **VNPay IPN bị cộng tiền 2 lần** | cách sửa khóa dòng đúng, nhưng **không có hàng đợi retry, DLQ hay replay**: khi handler có bug thì chỉ còn trông vào việc VNPay tự gửi lại, sửa xong cũng không có gì để chạy lại | IPN được lưu một lần, worker cộng tiền có retry, trạng thái dead-letter, CLI replay và đối soát `querydr` |
| **Webhook Stripe** | replay và đối soát **chỉ được mô tả trong README**; test trùng lặp chỉ đếm dòng inbox chứ không đếm thanh toán | CLI replay và đối soát `events.list` mỗi 15 phút bằng code thật; test ký bằng helper của Stripe; **10 lần gửi trùng đồng thời → đúng 1 thanh toán** |
| **Hóa đơn OpenAI tăng gấp 3: giới hạn theo khách** | hạn mức **mặc định không chặn gì** (chế độ observe); không có cảnh báo khi chi phí tăng đột biến | hạn mức $20/khách được áp dụng ngay, **giữ chỗ nguyên tử khi có request đồng thời**, cảnh báo khi chi tiêu vượt 3 lần trung bình 7 ngày, không tóm tắt lại ticket không đổi |
| **Semantic cache cho lời gọi LLM** | **mặc định cache cả câu trả lời không tất định** (temperature > 0) | chỉ cache request tất định, phạm vi theo tenant, chạy chế độ shadow cho tới khi đo được ngưỡng |

**Điểm: có bộ kit 100%, không có 66%**, trên cùng 57 tiêu chí (prompt và tiêu chí nằm trong [`evals/`](../../evals)).

## Hiệu quả thực tế

- **Giới hạn bảo mật nằm trong database, không nằm trong prompt.** Agent đặt giới hạn ở nơi prompt injection không
  với tới được: quyền GRANT, view đã che PII, Row-Level Security. Test nó viết sẽ fail nếu giới hạn bị thủng, chứ
  không phải loại test lúc nào cũng pass.
- **Code xử lý tiền chịu được thực tế.** Webhook đến trùng, đến muộn, sai thứ tự hay bị mất là chuyện bình thường.
  Agent dựng inbox, retry, dead-letter, replay và đối soát thành code chạy được.
- **Kiểm soát chi phí vững khi tải cao.** Ngân sách được giữ chỗ nguyên tử trước khi gọi API trả phí, nên mười
  request đồng thời không thể cùng lọt dưới hạn mức; chi phí tăng đột biến được báo ngay trong ngày.
- **Hỏi đúng quyết định thay vì đoán.** Chặn hay cho qua khi Redis lỗi? Có cho khách vãng lai tra cứu? Hạn mức mặc
  định là bao nhiêu? Agent hỏi, hoặc ghi lại mặc định đã chọn cùng lý do, và viết ADR để bạn duyệt.

## Những bug bộ kit giúp bạn tránh

Code mẫu mà agent dựa vào cũng được test trên Postgres và Redis thật. Đây là các vấn đề đã tìm ra trong chính code
mẫu (nhiều cái là sự cố production kinh điển), nay đã sửa và có test hồi quy bảo vệ:

| Vấn đề | Hậu quả trên production | Hiện tại |
|---|---|---|
| Rate limiter: timeout Redis để lại promise bị reject mà không ai bắt | **sập process Node** ở lần Redis chập chờn tiếp theo | đã bắt; test với Redis bị chặn |
| Test RLS bằng superuser của Docker | **không cách ly tenant gì cả**: superuser bỏ qua RLS kể cả khi `FORCE` | có cảnh báo và test với owner không phải superuser |
| Regex che PII trên dòng log 50KB | **1,9 giây CPU mỗi dòng log**, có thể bị DoS qua đường ghi log | **0,2 ms**; log có cấu trúc nhanh hơn 71% |
| Ngân sách LLM khi model thiếu trong bảng giá | chi phí bị tính $0, **ngân sách không bao giờ chặn** | từ chối khởi động |
| Lời gọi LLM vắt qua nửa đêm cuối tháng | phần giữ chỗ **kẹt vĩnh viễn ở tháng trước** | quyết toán đúng tháng đã giữ chỗ |
| Bucket dự phòng của rate limiter khi có nhiều key mới | **client bận nhất được cấp bucket đầy** đúng lúc sự cố | loại bỏ theo LRU thật |
| `SET LOCAL hnsw.iterative_scan` trên pgvector 0.5–0.7 | **thỉnh thoảng hỏng transaction** trên kết nối dùng lại | chỉ đặt khi được hỗ trợ |
| Worker webhook xử lý từng event một | 200 event, handler 5 ms: tồn đọng **3,2 giây** | **0,45 giây** với concurrency có giới hạn (nhanh hơn 7 lần) |
| Semantic cache: index HNSW kèm điều kiện lọc tenant | câu trả lời đã cache của chính tenant **bị trượt ở các câu hỏi phổ biến** (chỉ tìm thấy 4/20), mỗi lần trượt là một lần gọi model mất tiền | tìm chính xác trong phạm vi tenant: 20/20, 0,45 ms |
| Lệnh claim của worker webhook khi tồn đọng nhiều | mỗi lần claim phải sắp xếp toàn bộ hàng đợi: **56 ms mỗi lần claim khi có 200.000 event đến hạn**, chậm nhất đúng lúc cần nhanh nhất | 0,6 ms dù tồn đọng bao nhiêu |
| Relay outbox gặp lệnh gọi broker bị treo | **toàn bộ việc phát event dừng lại mà không báo lỗi**, khóa relay bị giữ mãi | có timeout cho publish; lần chạy sau tiếp tục bình thường |
| Upload vượt giới hạn | client nhận **kết nối bị reset thay vì 413** và upload lại từ đầu | trả về đúng 413; server chỉ đọc dưới 8 MB của file 32 MB |
| Feed SSE gặp tab trình duyệt bị treo | **bộ nhớ tăng không giới hạn**: 40 MB bị đệm cho một client trong test | ngắt client khi chậm quá 1.000 event, client kết nối lại và được phát lại |
| Rate limiter cấu hình `refillPerSec: 0` | mọi lần kiểm tra đều lỗi, limiter **âm thầm chạy ở chế độ dự phòng** | từ chối ngay khi khởi động |
| Prompt RAG 240 KB trong trace | span quá lớn bị loại bỏ: **chính những request lớn nhất không truy vết được** | giới hạn 32 KiB mỗi thuộc tính |
| Postgres ngắt kết nối giữa transaction (failover, `idle_in_transaction_session_timeout`) | **cả process Node bị sập**, kéo theo mọi request đang xử lý | chỉ request đó lỗi; có test ở mọi skill giữ kết nối |

## Nhanh hơn, và được đo so với các phương án khác

Với mỗi đường xử lý nóng, các phương án thực tế được benchmark song song trên Postgres và Redis thật, và code mẫu
dùng phương án thắng ([toàn bộ bảng số, query plan và đánh đổi](../performance.md)):

| Đường xử lý | So sánh | Phương án dùng | Mức cải thiện đo được |
|---|---|---|---|
| Gửi embedding vào Postgres | dạng text (17 hoặc 9 chữ số) và dạng binary | binary `vectorParam` | lookup và insert nhanh hơn ~3 lần, ít hơn 5 lần số byte |
| Lưu vector cho tìm kiếm chính xác | lưu ngoài dòng (mặc định), lưu trong dòng, `halfvec` | trong dòng (`STORAGE MAIN`) | nhanh hơn 2–3 lần, kết quả giống hệt |
| Tra cứu semantic cache | HNSW + lọc, HNSW iterative scan, tìm chính xác theo tenant | tìm chính xác; ANN tùy chọn cho tenant lớn | phương án duy nhất vừa đúng vừa nhanh nhất với tenant thông thường |
| Worker webhook | một vòng lặp chia lane song song, nhiều vòng lặp độc lập | `run({ loops })` | nhanh hơn 1,8 lần khi có handler chậm |
| Relay outbox | `UPDATE` từng message, `UPDATE` theo lô | theo lô | thông lượng gấp 8 lần |
| Giữ chỗ ngân sách LLM | hai câu lệnh, một câu upsert | upsert | độ trễ giảm 20%, thông lượng tăng 37% |
| Claim idempotency key | kiểm tra rồi insert, insert rồi chờ, try-lock + 409 | try-lock + 409 | 20 request trùng: handler chạy 1 lần thay vì 20; giữ kết nối pool 0,13 giây thay vì 4 giây |
| Transaction theo tenant (RLS) | 4 round trip, 3 round trip | 3 | mỗi request nhanh hơn 19%; bản thân RLS gần như không tốn gì |
| Client của rate limiter | mặc định của ioredis, auto-pipelining | mặc định (giữ nguyên) | auto-pipelining chậm hơn 11% |
| Che PII | có hint, không hint, một regex gộp | có hint (giữ nguyên) | nhanh hơn 1,3–4,7 lần so với các phương án khác |

Benchmark: `npm run bench:docker -- bench/compare/<tên>.ts` và `node bench/run.ts`. Các skill đang cân nhắc làm
tiếp: [roadmap](../roadmap.md).

## Bắt đầu nhanh

Copy skill vào thư mục skills của Claude Code (dùng cho mọi dự án), hoặc vào `<dự-án>/.claude/skills/`:

```powershell
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.claude\skills\"
```

Hoặc cài cả bộ dạng plugin trong terminal `claude`:

```text
/plugin marketplace add tuancuongpham/backend-production-kit
/plugin install backend-production-kit@backend-production-kit
```

Mỗi [release](https://github.com/tuancuongpham/backend-production-kit/releases/latest) cũng có từng skill dạng file
`.skill` để tải lên claude.ai. Sau đó chỉ cần mô tả việc cần làm ("thêm webhook Stripe", "giới hạn chi phí OpenAI
theo khách"); skill phù hợp sẽ tự được nạp.

## Các skill

| Skill | Dùng khi bạn… |
|---|---|
| [`agent-safe-db`](../../skills/agent-safe-db/SKILL.md) | cho agent, chatbot hay tính năng text-to-SQL truy cập database |
| [`pii-redaction`](../../skills/pii-redaction/SKILL.md) | dựng logging, tracing, báo lỗi có thể chạm dữ liệu cá nhân |
| [`multitenant-postgres`](../../skills/multitenant-postgres/SKILL.md) | tách dữ liệu nhiều khách trong một Postgres, kể cả RAG / vector search |
| [`webhook-ingestion`](../../skills/webhook-ingestion/SKILL.md) | nhận webhook thanh toán hoặc SaaS (Stripe, VNPay, MoMo, GitHub…) |
| [`outbox-pattern`](../../skills/outbox-pattern/SKILL.md) | phát event hoặc chạy tác vụ (AI) bất đồng bộ sau khi ghi DB |
| [`idempotency-keys`](../../skills/idempotency-keys/SKILL.md) | nhận POST bị gửi lại hoặc tool call của agent bị retry mà không trùng đơn, trùng tiền, trùng email |
| [`rate-limiting`](../../skills/rate-limiting/SKILL.md) | giới hạn request API, đăng nhập, endpoint LLM theo tenant hoặc user |
| [`service-hardening`](../../skills/service-hardening/SKILL.md) | đưa API lên Docker/Kubernetes mà không bị 502 hay treo khi deploy |
| [`llm-gateway`](../../skills/llm-gateway/SKILL.md) | kiểm soát chi phí LLM, thêm cache, chuyển model dự phòng khi provider lỗi |
| [`llm-observability`](../../skills/llm-observability/SKILL.md) | cần giải thích vì sao model trả lời như vậy |
| [`sse-streaming`](../../skills/sse-streaming/SKILL.md) | stream token hoặc cập nhật thời gian thực lên trình duyệt |
| [`adr-writer`](../../skills/adr-writer/SKILL.md) | ghi lại quyết định thiết kế, benchmark, bài phân tích |

## Tự kiểm chứng

```bash
npm install
npm run verify:up      # Postgres 17 + pgvector và Redis 7 trong Docker
npm test               # code mẫu chạy trên hạ tầng thật
npm run bench:docker -- bench/compare/webhook-claim.ts   # một bài so sánh phương án
npm run verify:down
```

CI chạy cùng bộ test ở mỗi lần push; mỗi phiên bản được gắn tag sẽ tự động đóng gói và phát hành.

## Đóng góp

Pattern mới và tiêu chí kiểm tra chặt hơn đều được hoan nghênh, xem [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).
Vấn đề bảo mật: vui lòng làm theo [SECURITY.md](../../.github/SECURITY.md).

## Giấy phép

[MIT](../../LICENSE)
