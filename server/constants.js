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
//  doc        which Sepidar template (receipt / issue)
//  type_code  value of the "نوع رسید / نوع" column. Receipt codes were read from your own export
//             (1 = خرید داخلی, 2 = تولید, 3 = سایر); the issue codes are a guess (فروش 1, مصرف 2, سایر 3, انتقال 4).
//  party      default کد تحویل‌دهنده / تحویل‌گیرنده (+ its title and internal id, copied from your export)
//  account    default کد حساب معین (receipts)
export const SEPIDAR_GROUPS = {
  purchase: { doc: 'receipt', kind: 'رسید انبار', type: 'خرید (داخلی)', type_code: '1', party: '60031', party_title: 'خريد متفرقه', party_id: '223', account: '211001' },
  production: { doc: 'receipt', kind: 'رسید انبار', type: 'تولید', type_code: '2', party: '1001', party_title: 'توليد', party_id: '93', account: '111601' },
  other_in: { doc: 'receipt', kind: 'رسید انبار', type: 'سایر', type_code: '3', party: '60029', party_title: 'ساير انبار1404', party_id: '210', account: '211001' },
  consumption: { doc: 'issue', kind: 'خروج انبار', type: 'مصرف', type_code: '2', party: '1001', party_title: 'توليد', party_id: '93', account: '' },
  sale: { doc: 'issue', kind: 'خروج انبار', type: 'فروش', type_code: '1', party: '', party_title: '', party_id: '', account: '' },
  other_out: { doc: 'issue', kind: 'خروج انبار', type: 'سایر', type_code: '3', party: '', party_title: '', party_id: '', account: '' },
  transfer: { doc: 'issue', kind: 'خروج انبار', type: 'انتقال بین انبار', type_code: '4', party: '', party_title: '', party_id: '', account: '' },
};

export const DEFAULT_WAREHOUSES = [
  { code: '1001', title: 'انبار مواد اولیه' },
  { code: '1002', title: 'موجودی انبار محصول' },
  { code: '1004', title: 'انبار واسط ضایعات' },
];

// Column titles of Sepidar's template export (file "الگو"): they use ARABIC letters (ي ك), so these literals must too.
// `key` says which value goes into the column. The item columns (قلم ...) come last: one row per item, with the
// document header repeated on every row; rows with the same number + warehouse form one document.
// The receipt titles are copied from your file; the issue titles follow the same naming and still have to be
// confirmed with an export of فهرست خروج انبار.
export const SEPIDAR_COLUMN_DEFAULTS = {
  receipt: [
    { key: 'item_kind', header: 'نوع قلم', enabled: true },
    { key: 'issuer', header: 'رسيد انبار صادر كننده', enabled: true },
    { key: 'issuer2', header: 'رسيد انبار صادر كننده (2)', enabled: true },
    { key: 'number', header: 'رسيد انبار شماره', enabled: true },
    { key: 'date', header: 'رسيد انبار تاريخ', enabled: true },
    { key: 'warehouse', header: 'رسيد انبار كد انبار', enabled: true },
    { key: 'warehouse_title', header: 'رسيد انبار عنوان انبار', enabled: true },
    { key: 'account', header: 'رسيد انبار كد حساب معين', enabled: true },
    { key: 'party', header: 'رسيد انبار كد تحويل دهنده', enabled: true },
    { key: 'party_id', header: 'رسيد انبار تحويل دهنده', enabled: true },
    { key: 'src_wh', header: 'رسيد انبار كد انبار مبدا', enabled: true },
    { key: 'src_wh_title', header: 'رسيد انبار عنوان انبار مبدا', enabled: true },
    { key: 'transfer_no', header: 'رسيد انبار شماره خروج انتقالي مرتبط', enabled: true },
    { key: 'type', header: 'رسيد انبار نوع رسيد', enabled: true },
    { key: 'acct_doc_no', header: 'رسيد انبار شماره سند حسابداري', enabled: true },
    { key: 'acct_doc_date', header: 'رسيد انبار تاريخ سند حسابداري', enabled: true },
    { key: 'net', header: 'رسيد انبار خالص', enabled: true },
    { key: 'carrier', header: 'رسيد انبار حمل كننده', enabled: true },
    { key: 'carrier_code', header: 'رسيد انبار كد حمل كننده', enabled: true },
    { key: 'notes', header: 'رسيد انبار توضيحات', enabled: true },
    { key: 'item_code', header: 'قلم رسيد انبار كد', enabled: true },
    { key: 'qty', header: 'قلم رسيد انبار واحد اصلي', enabled: true },
  ],
  issue: [
    { key: 'item_kind', header: 'نوع قلم', enabled: true },
    { key: 'issuer', header: 'خروج انبار صادر كننده', enabled: true },
    { key: 'issuer2', header: 'خروج انبار صادر كننده (2)', enabled: true },
    { key: 'number', header: 'خروج انبار شماره', enabled: true },
    { key: 'date', header: 'خروج انبار تاريخ', enabled: true },
    { key: 'warehouse', header: 'خروج انبار كد انبار', enabled: true },
    { key: 'warehouse_title', header: 'خروج انبار عنوان انبار', enabled: true },
    { key: 'party', header: 'خروج انبار كد تحويل گيرنده', enabled: true },
    { key: 'party_id', header: 'خروج انبار تحويل گيرنده', enabled: true },
    { key: 'dest', header: 'خروج انبار كد انبار مقصد', enabled: true },
    { key: 'dest_title', header: 'خروج انبار عنوان انبار مقصد', enabled: true },
    { key: 'type', header: 'خروج انبار نوع', enabled: true },
    { key: 'acct_doc_no', header: 'خروج انبار شماره سند حسابداري', enabled: true },
    { key: 'acct_doc_date', header: 'خروج انبار تاريخ سند حسابداري', enabled: true },
    { key: 'notes', header: 'خروج انبار توضيحات', enabled: true },
    { key: 'item_code', header: 'قلم خروج انبار كد', enabled: true },
    { key: 'qty', header: 'قلم خروج انبار واحد اصلي', enabled: true },
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
  sepidar_issuer: 'سرپرست',
  sepidar_next_no: {},
  sepidar_warehouses: DEFAULT_WAREHOUSES,
  sepidar_main_warehouse: '1001',
};
