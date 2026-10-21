<div align="center">

[English](../../README.md) · **Tiếng Việt**

# backend-production-kit

### Bộ skill backend chuẩn production cho AI agent lập trình.

**Dạy agent cách ra quyết định, không chỉ cách viết code — và bắt nó chứng minh kết quả bằng test.**

[![CI](https://img.shields.io/github/actions/workflow/status/trangrena/backend-production-kit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/trangrena/backend-production-kit/actions/workflows/ci.yml)
[![Skills](https://img.shields.io/badge/skills-11-2f81f7?style=flat-square)](#các-skill)
[![Verification tests](https://img.shields.io/badge/tests-108%20passing-2ea043?style=flat-square)](#kiểm-chứng)
[![Node 24](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat-square&logo=node.js&logoColor=white)](#kiểm-chứng)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)

</div>

AI agent viết code backend rất nhanh, nhưng không biết những đánh đổi của *bạn*. Redis chết thì rate limiter nên
cho request đi qua hay chặn lại? Role database của chatbot có bao giờ được phép ghi? Webhook đến hai lần thì sao?
Mỗi skill trong bộ này ghi sẵn các quyết định đó, các bước triển khai, và các test để chứng minh kết quả. Nhờ vậy
agent hỏi đúng câu hỏi, làm đúng những phần nhàm chán nhưng sống còn, và đưa cho bạn bằng chứng thay vì lời khẳng định.

## Bắt đầu nhanh

### Cài skill

Copy vào thư mục skills của Claude Code (dùng cho mọi dự án), hoặc vào `<dự-án>/.claude/skills/` (một dự án):

```powershell
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.claude\skills\"
```

Hoặc cài dạng plugin trong terminal `claude`:

```text
/plugin marketplace add trangrena/backend-production-kit
/plugin install backend-production-kit@backend-production-kit
```

### Sử dụng

Không cần gọi tên skill. Chỉ cần mô tả việc cần làm, skill phù hợp sẽ tự được nạp:

| Bạn nói với agent | Skill được dùng | Kết quả |
|---|---|---|
| "Cho chatbot CSKH tra cứu đơn hàng trong Postgres" | `agent-safe-db` | role chỉ đọc trên view đã che PII, tool có kiểu, timeout, audit, test chứng minh không ghi được |
| "Tích hợp VNPay IPN / webhook Stripe" | `webhook-ingestion` | verify chữ ký, inbox lũy đẳng, retry, DLQ, replay, đối soát |
| "Hóa đơn OpenAI tăng gấp 3, giới hạn chi phí theo khách" | `llm-gateway` | ngân sách nguyên tử theo tenant, cache, fallback, sổ chi phí, cảnh báo đột biến |
| "Khách A thấy được tài liệu của khách B" | `multitenant-postgres` | RLS có `FORCE`, composite FK, hybrid search an toàn theo tenant, audit trong CI |
| "Deploy là bị 502" | `service-hardening` | timeout, load shedding, probe, graceful shutdown |

## Các skill

| Skill | Nội dung | Test |
|---|---|---|
| [`agent-safe-db`](../../skills/agent-safe-db/SKILL.md) | Cho AI agent đọc DB mà không thể ghi, vượt tenant hay đọc PII thô | 13 |
| [`pii-redaction`](../../skills/pii-redaction/SKILL.md) | Che email, SĐT, CCCD, số thẻ, token trong log, trace, báo lỗi | 21 |
| [`multitenant-postgres`](../../skills/multitenant-postgres/SKILL.md) | Row-Level Security đúng cách, hybrid search pgvector + full-text (RRF) | 10 |
| [`webhook-ingestion`](../../skills/webhook-ingestion/SKILL.md) | Verify → lưu một lần → xử lý bất đồng bộ → retry → DLQ → replay → đối soát | 11 |
| [`outbox-pattern`](../../skills/outbox-pattern/SKILL.md) | Transactional outbox + relay giữ thứ tự + consumer chống trùng | 6 |
| [`rate-limiting`](../../skills/rate-limiting/SKILL.md) | Token bucket trên Redis, chọn rõ fail-open / fail-closed / local, có circuit breaker | 9 |
| [`service-hardening`](../../skills/service-hardening/SKILL.md) | Timeout, backpressure, liveness vs readiness, graceful shutdown (Node, kèm ghi chú Go) | 7 |
| [`llm-gateway`](../../skills/llm-gateway/SKILL.md) | Ngân sách giữ chỗ rồi quyết toán, cache exact + semantic chế độ shadow, fallback, sổ FinOps | 19 |
| [`llm-observability`](../../skills/llm-observability/SKILL.md) | Span OpenTelemetry tái dựng đúng những gì model đã thấy, xuyên qua queue | 4 |
| [`sse-streaming`](../../skills/sse-streaming/SKILL.md) | Stream token và live feed: replay, heartbeat, backpressure, hủy khi đóng tab | 6 |
| [`adr-writer`](../../skills/adr-writer/SKILL.md) | ADR, báo cáo benchmark, bài phân tích kiến trúc | 2 |

Mỗi `SKILL.md` gồm: **điểm quyết định** cần hỏi người dùng (kèm mặc định và lý do), **các bước triển khai** trỏ tới
code mẫu trong `references/`, **kiểm chứng** bằng test (không chỉ khẳng định suông), **ghi ADR**, và **lỗi hay gặp**.

## Kiểm chứng

```bash
npm install
npm run verify:up      # Postgres 17 + pgvector ở :55439, Redis 7 ở :63799 (Docker)
npm test               # 108 test
npm run verify:down
```

Trong lúc viết test đã phát hiện hai lỗi thật, hiện đã sửa và có test bảo vệ:

- **`rate-limiting`**: khi lời gọi Redis thua `Promise.race` vì hết giờ, nó vẫn reject sau đó mà không ai bắt,
  làm **sập process Node**.
- **`multitenant-postgres`**: superuser **luôn bỏ qua RLS, kể cả khi đã `FORCE`**. Nếu app kết nối bằng user
  mặc định của Docker thì việc cách ly tenant không có tác dụng.

## Đánh giá

Ba skill được đánh giá bằng skill-creator: cùng 6 prompt, so sánh agent có skill và không có skill, chấm bằng
assertion viết sẵn bởi các agent grader độc lập.

| Vòng | Thay đổi | Có skill | Không có skill |
|---|---|---|---|
| 1 | chạy lần đầu (assertion v1) | 100% | 81% |
| 2 | sửa skill theo nhận xét của grader, siết assertion (v2) | 93% | 66% |
| 3 | chạy lại bài 2, 4, 5 với skill đã sửa | **100%** | **66%** |

Phương pháp, chi tiết từng bài và các giới hạn (1 lần chạy cho mỗi cấu hình, assertion do chính người viết skill
soạn, chưa test nào được chạy trên DB thật): xem [docs/evaluation.md](../evaluation.md).

## Đóng góp

Mọi báo lỗi, pattern mới hay test chặt hơn đều được hoan nghênh, xem [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).
Vấn đề bảo mật: vui lòng làm theo [SECURITY.md](../../.github/SECURITY.md).

## Giấy phép

[MIT](../../LICENSE)
