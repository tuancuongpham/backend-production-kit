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

AI agent viết được backend *chạy được*. Thứ nó bỏ sót là những phần chỉ hỏng khi lên production: role của chatbot đọc
được số điện thoại của mọi khách hàng, webhook cộng tiền hai lần, ngân sách LLM bị các request đồng thời vượt qua. Mỗi
skill trong 20 skill trao cho agent, ở một mảng như vậy, các quyết định cần hỏi bạn, code mẫu và các test chứng minh
nó đứng vững. Trên sáu bài toán thật được người review độc lập chấm theo 57 tiêu chí production, cùng một agent đạt
66% khi không có bộ kit và 100% khi có ([phương pháp](../evaluation.md)).

## Các skill

Mọi con số dưới đây đến từ test và benchmark trong repo này, chạy trên Postgres, Redis và Toxiproxy thật.

### Dữ liệu và tenant

| Skill | Dùng khi bạn… | Làm đúng điều gì, đo được |
|---|---|---|
| [`agent-safe-db`](../../skills/agent-safe-db/SKILL.md) | cho agent hoặc chatbot truy cập database | role của agent chỉ đọc được view đã che dữ liệu, giới hạn trong một tenant bởi chính Postgres; lệnh ghi bị từ chối với *permission denied*; mỗi lần gọi tool tốn 0,51 ms |
| [`multitenant-postgres`](../../skills/multitenant-postgres/SKILL.md) | tách dữ liệu của các khách hàng trong cùng một Postgres, kể cả tìm kiếm vector | Row-Level Security được test bằng role của app (với superuser nó không cô lập gì cả); phần tìm theo từ khóa của hybrid search tìm được 10/10 câu hỏi gõ tự nhiên, trong khi đòi khớp mọi từ thì không tìm được câu nào |
| [`pii-redaction`](../../skills/pii-redaction/SKILL.md) | ghi log, trace hoặc báo lỗi có thể chứa dữ liệu cá nhân | số điện thoại, email, số thẻ, CCCD và secret được che ở mọi định dạng, kiểm tra trên hàng nghìn input sinh tự động; một dòng log 50 KB mất 0,2 ms thay vì 1,9 giây |
| [`data-retention-and-erasure`](../../skills/data-retention-and-erasure/SKILL.md) | xử lý yêu cầu xóa và xuất dữ liệu (GDPR, Nghị định 13/2023) và thời hạn lưu trữ | sau khi xóa một người, quét mọi cột văn bản không còn định danh nào của họ; dọn dữ liệu hết hạn giữ lại những gì còn trong hạn, kể cả trên bảng chia partition |
| [`zero-downtime-migrations`](../../skills/zero-downtime-migrations/SKILL.md) | đổi schema của bảng app đang dùng: index, constraint, backfill | lệnh đọc chờ 52 ms sau một `ALTER` bị chặn thay vì 1 giây; lệnh insert chờ 2 ms trong lúc build index thay vì 1,5 giây; backfill chạy tới cuối dù app vẫn đang ghi |

### Thanh toán và việc bất đồng bộ

| Skill | Dùng khi bạn… | Làm đúng điều gì, đo được |
|---|---|---|
| [`webhook-ingestion`](../../skills/webhook-ingestion/SKILL.md) | nhận webhook của Stripe, VNPay, MoMo hay GitHub | 10 bản trùng gửi đồng thời chỉ tạo một khoản thanh toán; retry, dead letter, replay và đối soát đều có trong code; một lần claim tốn 0,6 ms khi có 200.000 event đến hạn, thay vì 56 ms |
| [`idempotency-keys`](../../skills/idempotency-keys/SKILL.md) | nhận lại các POST hoặc lời gọi tool của agent bị gửi lại | 20 bản của cùng một request chỉ chạy handler một lần (cách kiểm tra rồi mới insert chạy tới 20 lần); một đơn hàng bị timeout không bao giờ bị request kế tiếp commit |
| [`outbox-pattern`](../../skills/outbox-pattern/SKILL.md) | phát event sau khi ghi database | không event nào được gửi trước khi commit hay bị mất sau đó; broker bị treo không làm dừng việc gửi; throughput của relay gấp 8 lần |
| [`job-queue`](../../skills/job-queue/SKILL.md) | gửi email, chạy việc LLM hoặc lên lịch job định kỳ | lease có heartbeat, retry, dead letter, mỗi lịch chỉ chạy một lần; một lần poll lúc rảnh tốn 0,3 ms bên cạnh 1 triệu job đã xong, thay vì 73 ms |

### Tải và sự cố

| Skill | Dùng khi bạn… | Làm đúng điều gì, đo được |
|---|---|---|
| [`rate-limiting`](../../skills/rate-limiting/SKILL.md) | giới hạn tần suất API, đăng nhập hoặc endpoint LLM | đúng 20 trên 90 lượt kiểm tra đồng thời qua được giới hạn 20, trên nhiều instance; khi Redis chậm hoặc sập, chính sách bạn chọn (open, closed hoặc local) quyết định trong chưa tới 300 ms |
| [`cache-stampede`](../../skills/cache-stampede/SKILL.md) | cache truy vấn hoặc kết quả LLM trong Redis | một key nóng hết hạn giữa 200 request chỉ gây 1 lần gọi gốc, không phải 200; bản cũ được trả trong 0,7 ms trong lúc một request làm mới nó |
| [`service-hardening`](../../skills/service-hardening/SKILL.md) | đưa API lên Docker hoặc Kubernetes | deploy không có 502 hay 503, kể cả với stream dài; khi quá tải, request bị từ chối trong chưa tới 150 ms thay vì mọi người cùng chờ timeout |
| [`resilience-testing`](../../skills/resilience-testing/SKILL.md) | cần biết điều gì xảy ra khi Postgres hay Redis chậm hoặc sập | mỗi kiểu sự cố có test bằng Toxiproxy: khi phản hồi trễ 1 giây, timeout phía client cắt lời gọi trong chưa tới 600 ms, còn `statement_timeout` không bao giờ kích hoạt |
| [`slo-alerting`](../../skills/slo-alerting/SKILL.md) | muốn cảnh báo chỉ gọi người trực khi có sự cố thật | tỉ lệ lỗi 10% gọi người trực sau 9 phút; rò rỉ 0,2% mở ticket và không bao giờ gọi người trực; các rule qua được `promtool` của Prometheus |

### Tính năng AI

| Skill | Dùng khi bạn… | Làm đúng điều gì, đo được |
|---|---|---|
| [`llm-gateway`](../../skills/llm-gateway/SKILL.md) | kiểm soát chi phí LLM, cache câu trả lời hoặc chuyển giữa các provider | ngân sách theo tenant được giữ chỗ nguyên tử, nên các request đồng thời không vượt được; provider đang chết chỉ nhận 1 lượt thử sau thời gian chờ, không phải mọi request đang đợi |
| [`llm-tool-safety`](../../skills/llm-tool-safety/SKILL.md) | cho agent gọi tool thay đổi dữ liệu hoặc chuyển tiền | khi đã có văn bản không tin cậy trong ngữ cảnh, mọi lệnh ghi phải chờ người duyệt, gắn với đúng các đối số của nó; lời gọi bị gửi lại chỉ hoàn tiền một lần |
| [`llm-observability`](../../skills/llm-observability/SKILL.md) | cần giải thích vì sao model trả lời như vậy | mỗi request một trace, HTTP → truy xuất → LLM, có phiên bản prompt, còn prompt và lỗi đều được che |
| [`rag-evals`](../../skills/rag-evals/SKILL.md) | đổi cách chia chunk, embedding hoặc cách truy xuất | cổng CI: bỏ bước chuẩn hóa dấu làm recall@5 tụt từ 1,00 xuống 0,42, và cổng nêu tên 7 truy vấn bị hỏng; 198 truy vấn trong 4,2 giây |
| [`sse-streaming`](../../skills/sse-streaming/SKILL.md) | stream token hoặc cập nhật trực tiếp tới trình duyệt | đóng tab thì dừng lời gọi model; kết nối lại thì nhận lại phần bị lỡ; tab bị treo bị ngắt thay vì đệm tới 40 MB |

### Quyết định

| Skill | Dùng khi bạn… | Làm đúng điều gì |
|---|---|---|
| [`adr-writer`](../../skills/adr-writer/SKILL.md) | ghi lại một quyết định thiết kế hoặc một benchmark | ADR được đánh số kèm mục lục: bối cảnh, quyết định, các phương án khác và con số đứng sau nó |

Mỗi `SKILL.md` liệt kê các quyết định cần hỏi, kèm mặc định và lý do, các bước có code mẫu, các tính chất mà test phải
chứng minh, và những lỗi skill đó sinh ra để ngăn.

## Bắt đầu nhanh

Copy skill vào thư mục skills của Claude Code (dùng cho mọi dự án), hoặc vào `<dự-án>/.claude/skills/`:

```bash
cp -r skills/* ~/.claude/skills/
```

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
theo khách"), skill phù hợp sẽ tự được nạp.

## Vì sao có thể tin code mẫu

- **Được chứng minh trên hạ tầng thật.** 458 test chạy trên Postgres 17 có pgvector, Redis 7 và Toxiproxy, phủ 99,5%
  số dòng của code mẫu; CI fail nếu tụt dưới 98%. Không có gì mà một khẳng định phụ thuộc vào bị mock.
- **Được rà lỗi tiềm ẩn qua từng vòng.** Mỗi vòng ghi các nghi ngờ thành test, và test phải fail trên code trước khi
  sửa. Đã qua bảy vòng; mọi bug cùng test của nó nằm trong [changelog](../../CHANGELOG.md).
- **Mỗi đường xử lý nóng được đo so với các phương án khác**, và phương án thắng được đưa vào code:
  [docs/performance.md](../performance.md).
- **Mười sáu bất biến** mọi skill đều giữ, mỗi cái là một bug bộ kit từng mắc: [docs/architecture.md](../architecture.md).

```bash
npm install && npm run check   # quy tắc skill, link, kiểu dữ liệu, lint: không cần Docker
npm run verify:up && npm test  # mọi test trên Postgres, Redis và Toxiproxy trong Docker
```

## Đóng góp

Pattern mới và tiêu chí kiểm tra chặt hơn đều được hoan nghênh: xem [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).
Vấn đề bảo mật: vui lòng làm theo [SECURITY.md](../../.github/SECURITY.md).

## Giấy phép

[MIT](../../LICENSE)
