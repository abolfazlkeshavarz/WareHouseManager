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

// Sepidar document types. Each approved document belongs to one Sepidar document (رسید انبار / خروج انبار and its type)
// and yields a barcode file for it (one item code per unit).
//  doc          receipt (رسید انبار) or issue (خروج انبار)
// Used only by the optional "bundle" (the creating .xls), values read from the template exports of the customer:
//  type_code    value of the "نوع رسید" / "نوع" column
//  party        default کد تحویل‌دهنده / تحویل‌گیرنده
//  account      receipts: کد حساب معین of the document;  line_account: issues: کد حساب معین of the item line
export const SEPIDAR_GROUPS = {
  purchase: { doc: 'receipt', kind: 'رسید انبار', type: 'خرید (داخلی)', type_code: '1', party: '60031', account: '211001' },
  production: { doc: 'receipt', kind: 'رسید انبار', type: 'تولید', type_code: '2', party: '1001', account: '111601' },
  other_in: { doc: 'receipt', kind: 'رسید انبار', type: 'سایر', type_code: '3', party: '60029', account: '211001' },
  consumption: { doc: 'issue', kind: 'خروج انبار', type: 'مصرف', type_code: '2', party: '1001', line_account: '111601' },
  sale: { doc: 'issue', kind: 'خروج انبار', type: 'فروش', type_code: '1', party: '', line_account: '' },
  other_out: { doc: 'issue', kind: 'خروج انبار', type: 'سایر', type_code: '3', party: '', line_account: '111304' },
  transfer: { doc: 'issue', kind: 'خروج انبار', type: 'انتقال بین انبار', type_code: '4', party: '', line_account: '' },
};

export const DEFAULT_WAREHOUSES = [
  { code: '1001', title: 'انبار مواد اولیه' },
  { code: '1002', title: 'موجودی انبار محصول' },
  { code: '1004', title: 'انبار  واسط ضایعات' }, // two spaces, exactly as Sepidar has it
];

export const DEFAULT_SETTINGS = {
  company_name: 'شرکت نیک نام طلاییه داران کاسپین',
  approval_required_out: true,
  approval_required_in: false,
  check_stock: true, // refuse stock-out lines larger than the current stock
  sepidar_warehouses: DEFAULT_WAREHOUSES,
  sepidar_main_warehouse: '1001',
  sepidar_next_no: {}, // last used Sepidar document number + 1, per "receipt:1001" / "issue:1001"
};
