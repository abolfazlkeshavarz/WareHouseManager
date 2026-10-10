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
// doc: which Sepidar template (receipt/issue). party: default کد تحویل‌دهنده / تحویل‌گیرنده (editable in settings).
export const SEPIDAR_GROUPS = {
  purchase: { doc: 'receipt', kind: 'رسید انبار', type: 'خرید (داخلی)', party: '60031' },
  production: { doc: 'receipt', kind: 'رسید انبار', type: 'تولید', party: '1001' },
  other_in: { doc: 'receipt', kind: 'رسید انبار', type: 'سایر', party: '60029' },
  consumption: { doc: 'issue', kind: 'خروج انبار', type: 'مصرف', party: '1001' },
  sale: { doc: 'issue', kind: 'خروج انبار', type: 'فروش', party: '' },
  other_out: { doc: 'issue', kind: 'خروج انبار', type: 'سایر', party: '' },
  transfer: { doc: 'issue', kind: 'خروج انبار', type: 'انتقال بین انبار', party: '' },
};

export const DEFAULT_WAREHOUSES = [
  { code: '1001', title: 'انبار مواد اولیه' },
  { code: '1002', title: 'موجودی انبار محصول' },
  { code: '1004', title: 'انبار واسط ضایعات' },
];

// Column titles of Sepidar's "الگوی دریافت" (import template), taken from the template dialogs. The import reads the
// first row as the header, so these titles must match the template; they are editable in settings.
// key = which value goes into the column.
export const SEPIDAR_COLUMN_DEFAULTS = {
  receipt: [
    { key: 'purchase_kind', header: 'رسید انبار نوع خرید', enabled: true },
    { key: 'type', header: 'رسید انبار نوع رسید', enabled: true },
    { key: 'number', header: 'رسید انبار شماره', enabled: true },
    { key: 'date', header: 'رسید انبار تاریخ', enabled: true },
    { key: 'warehouse', header: 'رسید انبار کد انبار', enabled: true },
    { key: 'party', header: 'رسید انبار کد تحویل دهنده', enabled: true },
    { key: 'account', header: 'رسید انبار کد حساب معین', enabled: true },
    { key: 'item_code', header: 'قلم رسید انبار کد', enabled: true },
    { key: 'qty', header: 'قلم رسید انبار واحد اصلی', enabled: true },
  ],
  issue: [
    { key: 'type', header: 'خروج انبار نوع خروج', enabled: true },
    { key: 'number', header: 'خروج انبار شماره', enabled: true },
    { key: 'date', header: 'خروج انبار تاریخ', enabled: true },
    { key: 'warehouse', header: 'خروج انبار کد انبار', enabled: true },
    { key: 'party', header: 'خروج انبار کد تحویل گیرنده', enabled: true },
    { key: 'dest', header: 'خروج انبار کد انبار مقصد', enabled: true },
    { key: 'item_code', header: 'قلم خروج انبار کد', enabled: true },
    { key: 'qty', header: 'قلم خروج انبار واحد اصلی', enabled: true },
  ],
};

export const DEFAULT_SETTINGS = {
  company_name: 'شرکت نیک نام طلاییه داران کاسپین',
  approval_required_out: true,
  approval_required_in: false,
  sepidar_enabled: false, // Sepidar import files are not finished yet (needs the real import template)
  sepidar_columns_v2: SEPIDAR_COLUMN_DEFAULTS,
  sepidar_party_codes: {},
  sepidar_account: '211001',
  sepidar_next_no: {},
  sepidar_warehouses: DEFAULT_WAREHOUSES,
  sepidar_main_warehouse: '1001',
};
