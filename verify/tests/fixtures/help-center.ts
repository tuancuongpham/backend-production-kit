// A small Vietnamese help center for retrieval evals (rag-evals test and bench). Users search with accents,
// sometimes without, and sometimes in full questions.
export const TENANT = '33333333-3333-4333-8333-333333333333';

export const CHUNKS: Record<string, string> = {
  'pay-momo': 'Thanh toán qua ví MoMo: chọn MoMo ở bước thanh toán và quét mã QR trong ứng dụng.',
  'pay-vnpay': 'Thanh toán bằng VNPay: hỗ trợ thẻ ATM nội địa và mã QR ngân hàng.',
  returns: 'Chính sách đổi trả: sản phẩm được đổi trả trong 30 ngày nếu còn nguyên tem mác.',
  'refund-time': 'Hoàn tiền được xử lý trong 5–7 ngày làm việc sau khi kho nhận lại hàng.',
  password: 'Quên mật khẩu: bấm Quên mật khẩu ở trang đăng nhập, mã xác nhận gửi qua email.',
  'shipping-fee': 'Phí vận chuyển: miễn phí cho đơn từ 300.000 đồng, nội thành Hà Nội và TP. Hồ Chí Minh.',
  'shipping-time': 'Thời gian giao hàng từ 2 đến 4 ngày; vùng sâu vùng xa có thể lâu hơn.',
  cancel: 'Hủy đơn hàng: bạn có thể hủy khi đơn chưa được giao cho đơn vị vận chuyển.',
  invoice: 'Xuất hóa đơn VAT: nhập mã số thuế công ty khi đặt hàng, hóa đơn điện tử gửi qua email.',
  phone: 'Đổi số điện thoại tài khoản: vào Hồ sơ, chọn Số điện thoại và xác thực bằng mã OTP.',
  hours: 'Giờ làm việc của tổng đài: 8 giờ đến 21 giờ, kể cả thứ Bảy và Chủ nhật.',
  warranty: 'Bảo hành 12 tháng cho thiết bị điện tử tại các trung tâm bảo hành chính hãng.',
};

const golden = (pairs: string[][], idPrefix: string, tag?: string) =>
  pairs.map(([query, chunk], i) => ({
    id: `${idPrefix}${i + 1}`,
    query,
    relevant: [chunk],
    tags: [tag ?? (/[^\p{ASCII}]/u.test(query) ? 'accents' : 'no-accents')],
  }));

/** Search-box style: a few keywords. */
export const KEYWORD_QUERIES = golden(
  [
    ['thanh toán MoMo', 'pay-momo'],
    ['chính sách đổi trả', 'returns'],
    ['hoàn tiền', 'refund-time'],
    ['quên mật khẩu', 'password'],
    ['phí vận chuyển', 'shipping-fee'],
    ['thời gian giao hàng', 'shipping-time'],
    ['hủy đơn hàng', 'cancel'],
    ['hóa đơn VAT', 'invoice'],
    ['đổi số điện thoại', 'phone'],
    ['giờ làm việc', 'hours'],
    ['thanh toan vnpay', 'pay-vnpay'],
    ['bao hanh', 'warranty'],
  ],
  'q',
);

/** Chat style: the same needs, asked as questions. */
export const QUESTION_QUERIES = golden(
  [
    ['làm sao thanh toán bằng ví MoMo?', 'pay-momo'],
    ['tôi muốn đổi trả sản phẩm thì sao?', 'returns'],
    ['bao lâu thì tôi được hoàn tiền?', 'refund-time'],
    ['tôi quên mật khẩu phải làm gì?', 'password'],
    ['phí vận chuyển là bao nhiêu?', 'shipping-fee'],
    ['giao hàng mất mấy ngày?', 'shipping-time'],
    ['làm thế nào để hủy đơn hàng?', 'cancel'],
    ['công ty tôi cần xuất hóa đơn VAT', 'invoice'],
    ['cách đổi số điện thoại trong tài khoản', 'phone'],
    ['tổng đài làm việc đến mấy giờ?', 'hours'],
  ],
  'qq',
  'question',
);
