// Single source of truth for roles, movement reasons and statuses. Sent to the client via /api/meta.

export const ROLES = {
  admin: 'مدیر سیستم',
  storekeeper: 'انباردار',
};

// direction: in = increases stock, out = decreases stock.
// sepidar: which Sepidar document group this reason is exported into (false = never exported).
// needs_dest: transfer to another warehouse, the destination must be chosen. dest_default: fixed destination.
export const REASONS = {
  // ورودی (رسید انبار)
  recharge: { direction: 'in', label: 'ورود جدید / خرید (خرید داخلی)', sepidar: 'purchase' },
  return_from_worker: { direction: 'in', label: 'بازگشت از کارگر / خط تولید (تولید)', sepidar: 'production' },
  other_in: { direction: 'in', label: 'سایر ورودی‌ها', sepidar: 'other_in' },
  opening: { direction: 'in', label: 'موجودی اولیه', sepidar: false },
  adjust_in: { direction: 'in', label: 'اصلاح شمارش (افزایش)', sepidar: false },
  // خروجی (خروج انبار)
  to_worker: { direction: 'out', label: 'تحویل به کارگر (مصرف)', sepidar: 'consumption' },
  sale: { direction: 'out', label: 'فروش', sepidar: 'sale' },
  scrap: { direction: 'out', label: 'ضایعات (انتقال به انبار ضایعات)', sepidar: 'transfer', dest_default: '1004' },
  transfer: { direction: 'out', label: 'انتقال به انبار دیگر', sepidar: 'transfer', needs_dest: true },
  other_out: { direction: 'out', label: 'سایر خروجی‌ها', sepidar: 'other_out' },
  adjust_out: { direction: 'out', label: 'اصلاح شمارش (کاهش)', sepidar: false },
};

export const DIRECTIONS = { in: 'ورود', out: 'خروج' };

export const STATUSES = {
  pending: 'در انتظار تایید',
  approved: 'تایید شده',
  rejected: 'رد شده',
  cancelled: 'لغو شده',
};

// Sepidar document groups: each one is one Sepidar document (رسید انبار / خروج انبار) with its own import file.
// Every value below was read from your own template exports (الگو رسید / الگو خروج), except where marked "guess".
//  doc        which Sepidar template (receipt / issue)
//  type_code  value of the "نوع رسيد" / "نوع" column
//  party      default کد تحویل‌دهنده / تحویل‌گیرنده ('' = must be chosen when exporting)
//  account    receipts: کد حساب معین of the header
//  line_account / line_account_title   issues: حساب معین of every item line
export const SEPIDAR_GROUPS = {
  purchase: { doc: 'receipt', kind: 'رسید انبار', type: 'خرید (داخلی)', type_code: '1', party: '60031', account: '211001' },
  production: { doc: 'receipt', kind: 'رسید انبار', type: 'تولید', type_code: '2', party: '1001', account: '111601' },
  other_in: { doc: 'receipt', kind: 'رسید انبار', type: 'سایر', type_code: '3', party: '60029', account: '211001' },
  consumption: { doc: 'issue', kind: 'خروج انبار', type: 'مصرف', type_code: '2', party: '1001', line_account: '111601', line_account_title: 'كاردرجريان ساخت' },
  sale: { doc: 'issue', kind: 'خروج انبار', type: 'فروش', type_code: '1', party: '', line_account: '', line_account_title: '' }, // type_code: guess
  other_out: { doc: 'issue', kind: 'خروج انبار', type: 'سایر', type_code: '3', party: '', line_account: '111304', line_account_title: 'ساير حسابها واسناد دريافتني' },
  transfer: { doc: 'issue', kind: 'خروج انبار', type: 'انتقال بین انبار', type_code: '4', party: '', line_account: '', line_account_title: '' },
};

// Parties seen in your exports: code -> internal id (receipt column "تحويل دهنده") and title (issue column "عنوان تحويل گيرنده").
export const SEPIDAR_KNOWN_PARTIES = {
  '1001': { id: '93', title: 'توليد' },
  '10020': { id: '67', title: 'مهر پلاست (طالبي)' },
  '10021': { id: '68', title: '' },
  '10036': { id: '84', title: 'گسترش صنعت قالب' },
  '10056': { id: '113', title: 'شركت امير پلاستيك' },
  '10095': { id: '155', title: 'آبسان مهر البرز' },
  '10097': { id: '158', title: '' },
  '10102': { id: '163', title: '' },
  '10108': { id: '169', title: '' },
  '25250': { id: '182', title: '' },
  '60027': { id: '208', title: '' },
  '60029': { id: '210', title: 'ساير انبار1404' },
  '60031': { id: '223', title: 'خريد متفرقه' },
  '60032': { id: '224', title: '' },
  '60033': { id: '', title: 'اروند سيم' },
  '60034': { id: '', title: 'حقگو شركت رنگ ' },
};

export const DEFAULT_WAREHOUSES = [
  { code: '1001', title: 'انبار مواد اولیه' },
  { code: '1002', title: 'موجودی انبار محصول' },
  { code: '1004', title: 'انبار  واسط ضایعات' }, // two spaces, exactly as Sepidar has it
];

// Sepidar fills the template's fields BY POSITION (confirmed from the import preview), starting with "نوع قلم".
// Column titles and ORDER copied from your two template exports (sheet "Test"). Only the real data columns are
// enabled by default: Sepidar's receive template rejects a file that has more columns than the template selects
// ("تعداد ستون های فایل ورودی بیشتر از ستون های انتخاب شده است"), and the other columns are display-only. Turn more
// on in settings only if your template selects them.
// (original note:) Column titles and ORDER copied from your two template exports (sheet "Test"): they use ARABIC letters (ي ك).
// `key` says which value goes into the column. One row per item; the document header is repeated on every row,
// and rows with the same number + warehouse form one document.
export const SEPIDAR_COLUMN_DEFAULTS = {
  receipt: [
    { key: "item_kind", header: 'نوع قلم', enabled: true },
    { key: "issuer", header: 'رسيد انبار صادر كننده', enabled: false },
    { key: "issuer2", header: 'رسيد انبار صادر كننده (2)', enabled: false },
    { key: "number", header: 'رسيد انبار شماره', enabled: true },
    { key: "date", header: 'رسيد انبار تاريخ', enabled: true },
    { key: "warehouse", header: 'رسيد انبار كد انبار', enabled: true },
    { key: "warehouse_title", header: 'رسيد انبار عنوان انبار', enabled: false },
    { key: "account", header: 'رسيد انبار كد حساب معين', enabled: true },
    { key: "party", header: 'رسيد انبار كد تحويل دهنده', enabled: true },
    { key: "party_id", header: 'رسيد انبار تحويل دهنده', enabled: false },
    { key: "src_wh", header: 'رسيد انبار كد انبار مبدا', enabled: false },
    { key: "src_wh_title", header: 'رسيد انبار عنوان انبار مبدا', enabled: false },
    { key: "transfer_no", header: 'رسيد انبار شماره خروج انتقالي مرتبط', enabled: false },
    { key: "type", header: 'رسيد انبار نوع رسيد', enabled: true },
    { key: "acct_doc_no", header: 'رسيد انبار شماره سند حسابداري', enabled: false },
    { key: "acct_doc_date", header: 'رسيد انبار تاريخ سند حسابداري', enabled: false },
    { key: "net", header: 'رسيد انبار خالص', enabled: false },
    { key: "carrier", header: 'رسيد انبار حمل كننده', enabled: false },
    { key: "carrier_code", header: 'رسيد انبار كد حمل كننده', enabled: false },
    { key: "notes", header: 'رسيد انبار توضيحات', enabled: false },
    { key: "row_no", header: 'قلم رسيد انبار رديف', enabled: true },
    { key: "base", header: 'قلم رسيد انبار مبنا', enabled: false },
    { key: "item_code", header: 'قلم رسيد انبار كد', enabled: true },
    { key: "item_title", header: 'قلم رسيد انبار عنوان', enabled: false },
    { key: "qty", header: 'قلم رسيد انبار واحد اصلي', enabled: true },
    { key: "price", header: 'قلم رسيد انبار في', enabled: false },
    { key: "line_total", header: 'قلم رسيد انبار كل', enabled: false },
    { key: "line_notes", header: 'قلم رسيد انبار توضيحات', enabled: false },
  ],
  issue: [
    { key: "item_kind", header: 'نوع قلم', enabled: true },
    { key: "notes", header: 'خروج انبار توضيحات', enabled: false },
    { key: "number", header: 'خروج انبار شماره', enabled: true },
    { key: "issuer", header: 'خروج انبار صادر كننده', enabled: false },
    { key: "issuer2", header: 'خروج انبار صادر كننده (2)', enabled: false },
    { key: "date", header: 'خروج انبار تاريخ', enabled: true },
    { key: "warehouse", header: 'خروج انبار كد انبار', enabled: true },
    { key: "warehouse_title", header: 'خروج انبار عنوان انبار', enabled: false },
    { key: "party", header: 'خروج انبار كد تحويل گيرنده', enabled: true },
    { key: "party_title", header: 'خروج انبار عنوان تحويل گيرنده', enabled: false },
    { key: "dest", header: 'خروج انبار كد انبار مقصد', enabled: true },
    { key: "dest_title", header: 'خروج انبار عنوان انبار مقصد', enabled: false },
    { key: "proforma_no", header: 'خروج انبار شماره پيش فاكتور مرتبط', enabled: false },
    { key: "type", header: 'خروج انبار نوع', enabled: true },
    { key: "acct_doc_no", header: 'خروج انبار شماره سند حسابداري', enabled: false },
    { key: "acct_doc_date", header: 'خروج انبار تاريخ سند حسابداري', enabled: false },
    { key: "total", header: 'خروج انبار مبلغ كل', enabled: false },
    { key: "by_invoice", header: 'خروج انبار بر مبناي فاكتور', enabled: false },
    { key: "row_no", header: 'قلم خروج انبار رديف', enabled: true },
    { key: "item_code", header: 'قلم خروج انبار كد', enabled: true },
    { key: "item_title", header: 'قلم خروج انبار عنوان', enabled: false },
    { key: "qty", header: 'قلم خروج انبار واحد اصلي', enabled: true },
    { key: "line_account", header: 'قلم خروج انبار كد حساب معين', enabled: true },
    { key: "line_account_title", header: 'قلم خروج انبار عنوان1', enabled: false },
    { key: "price", header: 'قلم خروج انبار في', enabled: false },
    { key: "amount", header: 'قلم خروج انبار مبلغ', enabled: false },
    { key: "line_notes", header: 'قلم خروج انبار توضيحات', enabled: false },
  ],
};

export const DEFAULT_SETTINGS = {
  company_name: 'شرکت نیک نام طلاییه داران کاسپین',
  approval_required_out: true,
  approval_required_in: false,
  sepidar_enabled: false, // Sepidar import files are not finished yet (needs the real import template)
  sepidar_columns_v2: SEPIDAR_COLUMN_DEFAULTS,
  sepidar_party_codes: {},
  sepidar_accounts: {},
  sepidar_issuer_id: '',
  sepidar_titles: false,
  sepidar_date_format: 'with_time', // what Sepidar's own export writes; the importer returned an empty date for the plain forms we tried
  sepidar_next_no: {},
  sepidar_warehouses: DEFAULT_WAREHOUSES,
  sepidar_main_warehouse: '1001',
};
