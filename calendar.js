/**
 * Telegram Inline Keyboard Calendar
 * Bugünden 2 ay sonrasına kadar tarih seçimi sunar.
 */

const DAYS_TR = ['Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct', 'Pz'];
const MONTHS_TR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

/**
 * Belirli bir ay/yıl için takvim inline keyboard oluşturur.
 * @param {number} year 
 * @param {number} month (0-indexed)
 * @returns {object} Telegram inline_keyboard reply_markup
 */
function generateCalendar(year, month) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Max tarih: bugünden 2 ay sonra
  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 2);
  maxDate.setHours(23, 59, 59, 999);

  // Min date: today
  const minDate = new Date();
  minDate.setHours(0, 0, 0, 0);

  const keyboard = [];

  // Ay başlığı satırı
  const monthTitle = `📅 ${MONTHS_TR[month]} ${year}`;
  keyboard.push([{ text: monthTitle, callback_data: 'cal_ignore' }]);

  // Gün isimleri satırı
  const dayHeaders = DAYS_TR.map(d => ({ text: d, callback_data: 'cal_ignore' }));
  keyboard.push(dayHeaders);

  // Ayın ilk günü
  const firstDay = new Date(year, month, 1);
  // Pazartesi = 0 olacak şekilde ayarla (JS'de Pazar=0)
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6; // Pazar

  // Aydaki gün sayısı
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let row = [];
  // Boş hücreler (ayın başlangıcından öncesi)
  for (let i = 0; i < startDow; i++) {
    row.push({ text: ' ', callback_data: 'cal_ignore' });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month, day);
    currentDate.setHours(0, 0, 0, 0);

    const dateStr = formatDate(year, month, day);
    const isToday = currentDate.getTime() === today.getTime();
    const isPast = currentDate < today;
    const isFuture = currentDate > maxDate;

    let text;
    let callbackData;

    if (isPast || isFuture) {
      text = '·';
      callbackData = 'cal_ignore';
    } else if (isToday) {
      text = `[${day}]`;
      callbackData = `cal_select_${dateStr}`;
    } else {
      text = `${day}`;
      callbackData = `cal_select_${dateStr}`;
    }

    row.push({ text, callback_data: callbackData });

    if (row.length === 7) {
      keyboard.push(row);
      row = [];
    }
  }

  // Son satırı doldur
  if (row.length > 0) {
    while (row.length < 7) {
      row.push({ text: ' ', callback_data: 'cal_ignore' });
    }
    keyboard.push(row);
  }

  // Navigasyon butonları
  const navRow = [];
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  const prevDate = new Date(prevYear, prevMonth, 1);
  const currentMonthDate = new Date(year, month, 1);
  const todayMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  // Önceki ay butonu (sadece bugünün ayından geri gidemez)
  if (currentMonthDate > todayMonth) {
    navRow.push({ text: '◀️ ' + MONTHS_TR[prevMonth], callback_data: `cal_nav_${prevYear}_${prevMonth}` });
  } else {
    navRow.push({ text: ' ', callback_data: 'cal_ignore' });
  }

  // Sonraki ay butonu (max 2 ay ilerisine)
  const nextDate = new Date(nextYear, nextMonth, 1);
  if (nextDate <= maxDate) {
    navRow.push({ text: MONTHS_TR[nextMonth] + ' ▶️', callback_data: `cal_nav_${nextYear}_${nextMonth}` });
  } else {
    navRow.push({ text: ' ', callback_data: 'cal_ignore' });
  }

  keyboard.push(navRow);

  // İptal butonu
  keyboard.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

  return { inline_keyboard: keyboard };
}

/**
 * Tarih formatla: YYYY-MM-DD
 */
function formatDate(year, month, day) {
  const m = String(month + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/**
 * Bugünün yıl ve ayını döndürür
 */
function getCurrentMonthYear() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

/**
 * Tarih string'ini güzel Türkçe formata çevirir
 */
function formatDateTurkish(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS_TR[month - 1]} ${year}`;
}

module.exports = {
  generateCalendar,
  getCurrentMonthYear,
  formatDateTurkish,
  MONTHS_TR
};
