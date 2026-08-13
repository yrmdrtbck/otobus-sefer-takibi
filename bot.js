require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const obiletApi = require('./obilet-api');
const db = require('./db');
const watcher = require('./watcher');
const calendar = require('./calendar');
const cityMatcher = require('./city-matcher');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is missing in .env file');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.setMyCommands([
  { command: '/start', description: 'Menüyü Göster' },
  { command: '/sefer', description: 'Sefer İncele / Alarm Kur' },
  { command: '/listem', description: 'Aktif Alarmlarımı Göster' }
]);

// Start the background watcher
watcher.startWatcher(bot);

// ==========================================
// Processing Lock - Aynı anda 2 istek engeli
// ==========================================
const processingLock = new Map(); // chatId -> boolean

function isProcessing(chatId) {
  return processingLock.get(chatId) === true;
}

function setProcessing(chatId, value) {
  if (value) {
    processingLock.set(chatId, true);
  } else {
    processingLock.delete(chatId);
  }
}

// ==========================================
// Yardımcı: Hata durumunda aksiyon butonları
// ==========================================
function getErrorButtons(user) {
  const buttons = [];

  // Eğer origin ve dest varsa tarih değiştirme butonu göster
  if (user.temp && user.temp.originId && user.temp.destinationId) {
    buttons.push([{ text: '📅 Tarihi Değiştir', callback_data: 'action_change_date' }]);
  }

  // Kalkış ve varış şehrini değiştir
  if (user.temp && user.temp.originId) {
    buttons.push([{ text: '🏙️ Varış Şehrini Değiştir', callback_data: 'action_change_dest' }]);
  }
  buttons.push([{ text: '🏙️ Kalkış Şehrini Değiştir', callback_data: 'action_change_origin' }]);
  buttons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

  return { inline_keyboard: buttons };
}

// ==========================================
// Yardımcı: Şehir arama (fuzzy destekli)
// ==========================================
async function smartCitySearch(query) {
  // Önce API'den dene
  let results = await obiletApi.searchCity(query);

  if (results.length === 0) {
    // API boş döndü → fuzzy match ile düzeltmeyi dene
    const corrected = cityMatcher.findClosestCity(query);
    if (corrected && corrected.toLowerCase() !== query.toLowerCase()) {
      console.log(`[CityMatcher] "${query}" → "${corrected}" düzeltildi`);
      results = await obiletApi.searchCity(corrected);
    }
  }

  return results;
}

// ==========================================
// Yardımcı: Sefer listesi oluşturucu (pagination + sort)
// ==========================================
const JOURNEYS_PER_PAGE = 5;

function buildJourneyListMessage(user, page, sortBy) {
  const allJourneys = user.temp.allJourneys || [];

  // Sıralama
  let sorted = [...allJourneys];
  if (sortBy === 'price') {
    sorted.sort((a, b) => a.journey['internet-price'] - b.journey['internet-price']);
  } else {
    // Varsayılan: saate göre
    sorted.sort((a, b) => {
      const ta = a.journey.departure.split('T')[1] || '';
      const tb = b.journey.departure.split('T')[1] || '';
      return ta.localeCompare(tb);
    });
  }

  const totalPages = Math.ceil(sorted.length / JOURNEYS_PER_PAGE);
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const start = page * JOURNEYS_PER_PAGE;
  const pageJourneys = sorted.slice(start, start + JOURNEYS_PER_PAGE);

  // journeyMap güncelle (global index kullan)
  const journeyMap = {};
  sorted.forEach((j, i) => { journeyMap[i + 1] = j; });

  const dateStr = user.temp.date;
  const dateTurkish = calendar.formatDateTurkish(dateStr);
  const sortLabel = sortBy === 'price' ? '💰 Fiyat' : '🕐 Saat';

  let listTxt = `🚌 *${user.temp.originName} → ${user.temp.destName}*\n`;
  listTxt += `📅 ${dateTurkish} • Sıralama: ${sortLabel}\n`;
  listTxt += `📄 Sayfa ${page + 1}/${totalPages} (${sorted.length} sefer)\n\n`;

  const journeyButtons = [];

  pageJourneys.forEach((j, localIdx) => {
    const globalNum = start + localIdx + 1;
    const departureTime = j.journey.departure.split('T')[1].substring(0, 5);
    const price = j.journey['internet-price'];
    const partnerName = j['partner-name'] || 'Firma';

    listTxt += `*${globalNum}.* 🏢 ${partnerName}\n    🕐 ${departureTime} • 💰 ${price} TL\n\n`;

    journeyButtons.push([{
      text: `${globalNum}. ${partnerName} - ${departureTime} (${price} TL)`,
      callback_data: `journey_${globalNum}`
    }]);
  });

  // Navigasyon satırı
  const navRow = [];
  if (page > 0) {
    navRow.push({ text: '◀️ Önceki', callback_data: `jpage_${page - 1}_${sortBy}` });
  }
  if (page < totalPages - 1) {
    navRow.push({ text: 'Sonraki ▶️', callback_data: `jpage_${page + 1}_${sortBy}` });
  }
  if (navRow.length > 0) journeyButtons.push(navRow);

  // Sıralama butonları
  const sortRow = [];
  if (sortBy !== 'time') {
    sortRow.push({ text: '🕐 Saate Göre Sırala', callback_data: `jsort_0_time` });
  }
  if (sortBy !== 'price') {
    sortRow.push({ text: '💰 Fiyata Göre Sırala', callback_data: `jsort_0_price` });
  }
  journeyButtons.push(sortRow);

  // İptal
  journeyButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

  return { text: listTxt + 'Lütfen bir sefer seçin:', buttons: journeyButtons, journeyMap };
}

// ==========================================
// /start komutu
// ==========================================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  db.updateUser(chatId, { state: 'IDLE', temp: {} });
  setProcessing(chatId, false);
  bot.sendMessage(chatId, `🚌 *Obilet İzleyici Botuna Hoş Geldiniz!*\n\nBu bot ile otobüs seferlerini takip edebilir, koltuklar boşaldığında veya belirli bir doluluk oranına ulaştığında bildirim alabilirsiniz.\n\nYeni bir sefer incelemek veya alarm başlatmak için /sefer komutunu kullanın.\nAktif izlemelerinizi görmek için /listem komutunu kullanın.`, { parse_mode: 'Markdown' });
});

// ==========================================
// /sefer komutu
// ==========================================
bot.onText(/\/sefer/, async (msg) => {
  const chatId = msg.chat.id;
  if (isProcessing(chatId)) {
    bot.sendMessage(chatId, '⏳ Önceki isteğiniz işleniyor, lütfen bekleyin...');
    return;
  }
  const promptMsg = await bot.sendMessage(chatId, '📍 Nereden yola çıkacaksınız? (şehir veya ilçe adı)');
  db.updateUser(chatId, { state: 'WAITING_ORIGIN', temp: { mode: 'SEFER', promptMsgId: promptMsg.message_id } });
});

// ==========================================
// /listem komutu
// ==========================================
bot.onText(/\/listem/, (msg) => {
  const chatId = msg.chat.id;
  const alarms = db.getUserAlarms(chatId);
  if (alarms.length === 0) {
    bot.sendMessage(chatId, 'Şu anda aktif bir izlemeniz bulunmuyor.');
    return;
  }
  let txt = '📝 *Aktif İzlemeleriniz:*\n\n';
  const inline_keyboard = [];
  alarms.forEach((a, i) => {
    txt += `${i + 1}. *${a.busName}* - ${a.date} ${a.departure}\n`;
    if (a.type === 'CAPACITY') {
      txt += `   └ Kapasite: ${a.capacityLimit} veya daha az koltuk kalınca haber ver.\n`;
    } else if (a.type === 'ANY_SEAT_EMPTY') {
      txt += `   └ Herhangi bir koltuk boşaldığında haber ver.\n`;
    }
    inline_keyboard.push([{ text: `❌ ${i + 1}. İzleyiciyi Sil`, callback_data: `alarm_delete_${a.id}` }]);
  });
  bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
});

// ==========================================
// Callback Query Handler (Butonlar)
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  // "cal_ignore" → boş tıklama
  if (data === 'cal_ignore') {
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Takvim navigasyonu: cal_nav_YYYY_M
  if (data.startsWith('cal_nav_')) {
    const parts = data.split('_');
    const year = parseInt(parts[2]);
    const month = parseInt(parts[3]);
    const calendarMarkup = calendar.generateCalendar(year, month);

    try {
      await bot.editMessageReplyMarkup(calendarMarkup, {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (e) {
      // Mesaj değişmemiş olabilir
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Tarih seçimi: cal_select_YYYY-MM-DD
  if (data.startsWith('cal_select_')) {
    const dateStr = data.replace('cal_select_', '');
    const user = db.getUser(chatId);

    if (user.state !== 'WAITING_DATE') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }

    if (isProcessing(chatId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'İşlem devam ediyor, bekleyin...' });
      return;
    }

    setProcessing(chatId, true);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `📅 ${calendar.formatDateTurkish(dateStr)} seçildi` });

    // Takvim mesajını sil
    bot.deleteMessage(chatId, messageId).catch(() => {});

    try {
      const statusMsg = await bot.sendMessage(chatId, 'Seferler aranıyor, lütfen bekleyin... ⏳');
      const journeys = await obiletApi.getJourneys(user.temp.originId, user.temp.destinationId, dateStr);
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      if (journeys.length === 0) {
        const errorMarkup = getErrorButtons(user);
        bot.sendMessage(chatId,
          `❌ *${calendar.formatDateTurkish(dateStr)}* tarihinde *${user.temp.originName} → ${user.temp.destName}* güzergahında sefer bulunamadı.\n\nNe yapmak istersiniz?`,
          { parse_mode: 'Markdown', reply_markup: errorMarkup }
        );
        // state'i silmeyelim, butonlarla devam edebilsin
        db.updateUser(chatId, { state: 'WAITING_ACTION', temp: { ...user.temp, date: dateStr } });
        setProcessing(chatId, false);
        return;
      }

      // Sefer listesi - pagination ile
      const tempUser = { temp: { ...user.temp, date: dateStr, allJourneys: journeys } };
      const { text: listTxt, buttons: journeyButtons, journeyMap } = buildJourneyListMessage(tempUser, 0, 'time');

      db.updateUser(chatId, {
        state: 'WAITING_JOURNEY',
        temp: { ...user.temp, date: dateStr, allJourneys: journeys, journeyMap, currentPage: 0, sortBy: 'time' }
      });

      bot.sendMessage(chatId, listTxt, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: journeyButtons }
      });
    } catch (err) {
      console.error('Error fetching journeys:', err);
      bot.sendMessage(chatId, '❌ Seferler aranırken bir hata oluştu.', {
        reply_markup: getErrorButtons(user)
      });
    } finally {
      setProcessing(chatId, false);
    }
    return;
  }

  // Sayfa değiştirme: jpage_{page}_{sortBy}
  if (data.startsWith('jpage_')) {
    const parts = data.split('_');
    const page = parseInt(parts[1]);
    const sortBy = parts[2];
    const user = db.getUser(chatId);

    if (user.state !== 'WAITING_JOURNEY') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }

    const { text: listTxt, buttons: journeyButtons, journeyMap } = buildJourneyListMessage(user, page, sortBy);

    db.updateUser(chatId, {
      state: 'WAITING_JOURNEY',
      temp: { ...user.temp, journeyMap, currentPage: page, sortBy: sortBy }
    });

    try {
      await bot.editMessageText(listTxt, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: journeyButtons }
      });
    } catch (e) { }

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Sıralama değiştirme: jsort_{page}_{sortBy}
  if (data.startsWith('jsort_')) {
    const parts = data.split('_');
    const page = parseInt(parts[1]);
    const sortBy = parts[2];
    const user = db.getUser(chatId);

    if (user.state !== 'WAITING_JOURNEY') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }

    // Sıralama değiştiğinde her zaman ilk sayfaya dön
    const newPage = 0;
    const { text: listTxt, buttons: journeyButtons, journeyMap } = buildJourneyListMessage(user, newPage, sortBy);

    db.updateUser(chatId, {
      state: 'WAITING_JOURNEY',
      temp: { ...user.temp, journeyMap, currentPage: newPage, sortBy: sortBy }
    });

    try {
      await bot.editMessageText(listTxt, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: journeyButtons }
      });
    } catch (e) { }

    await bot.answerCallbackQuery(callbackQuery.id, { text: sortBy === 'price' ? 'Fiyata göre sıralandı' : 'Saate göre sıralandı' });
    return;
  }

  // Sefer seçimi: journey_N
  if (data.startsWith('journey_')) {
    const num = parseInt(data.replace('journey_', ''));
    const user = db.getUser(chatId);

    if (user.state !== 'WAITING_JOURNEY') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }

    if (isProcessing(chatId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'İşlem devam ediyor, bekleyin...' });
      return;
    }

    const journeyMap = user.temp.journeyMap;
    if (!journeyMap || !journeyMap[num]) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Geçersiz sefer.' });
      return;
    }

    setProcessing(chatId, true);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Sefer detayları yükleniyor...' });

    // Sefer listesi mesajını güncelle
    const selectedJourney = journeyMap[num];
    try {
      await bot.editMessageText(
        `✅ *${selectedJourney['partner-name']}* (${selectedJourney.journey.departure.split('T')[1].substring(0, 5)}) seferi seçildi.`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
      );
    } catch (e) { }

    try {
      const statusMsg = await bot.sendMessage(chatId, '🔍 Otobüsün anlık durumu sorgulanıyor... ⏳');

      const jId = selectedJourney.id;
      const originId = user.temp.originId;
      const destId = user.temp.destinationId;
      const date = user.temp.date;

      const details = await obiletApi.getJourneyDetails(jId, originId, destId, date);
      let totalSeats = 0;
      let availableSeats = 0;
      let availableList = [];
      let seatData = [];

      if (details && details.bus) {
        const seats = obiletApi.parseSeats(details.bus);
        seatData = seats;
        totalSeats = seats.length;
        availableSeats = seats.filter(s => s.available).length;
        availableList = seats.filter(s => s.available).map(s => s.number);
      } else {
        bot.sendMessage(chatId, '❌ Otobüs detayı alınamadı.', {
          reply_markup: getErrorButtons(user)
        });
        db.updateUser(chatId, { state: 'WAITING_ACTION', temp: user.temp });
        setProcessing(chatId, false);
        return;
      }

      // Premium kart oluştur (otobüs yerleşimi dahil)
      const departureTime = selectedJourney.journey.departure.split('T')[1].substring(0, 5);
      const price = selectedJourney.journey['internet-price'];

      const cardMessageText = obiletApi.formatJourneyCardText({
        partnerName: selectedJourney['partner-name'] || 'Firma',
        originName: user.temp.originName,
        destName: user.temp.destName,
        departureTime,
        date,
        price,
        totalSeats,
        availableSeats,
        seatData
      });

      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      await bot.sendMessage(chatId, cardMessageText, { parse_mode: 'Markdown' });

      db.updateUser(chatId, {
        state: 'WAITING_ALARM_TYPE',
        temp: {
          ...user.temp,
          journeyId: selectedJourney.id,
          busName: selectedJourney['partner-name'],
          departure: departureTime,
          initialAvailable: availableSeats,
          soldSeats: seatData.filter(s => !s.available).map(s => s.number)
        }
      });

      const doneButtons = {
        inline_keyboard: [
          [{ text: '💺 Herhangi bir koltuk boşaldığında bildirim al', callback_data: 'alarm_empty' }],
          [{ text: '📊 X adet koltuk dolduğunda bildirim al', callback_data: 'alarm_capacity' }],
          [{ text: '🔄 Başka bir sefer incele', callback_data: 'action_change_date' }],
          [{ text: '🏠 Ana Menüye Dön', callback_data: 'action_cancel' }]
        ]
      };
      bot.sendMessage(chatId, '✅ Sefer detayları yüklendi. Ne yapmak istersiniz?', {
        reply_markup: doneButtons
      });
    } catch (err) {
      console.error('Error fetching journey details:', err);
      bot.sendMessage(chatId, '❌ Sefer detayı alınırken hata oluştu.', {
        reply_markup: getErrorButtons(user)
      });
    } finally {
      setProcessing(chatId, false);
    }
    return;
  }

  // Alarm tipi seçimi
  if (data === 'alarm_capacity') {
    const user = db.getUser(chatId);
    if (user.state !== 'WAITING_ALARM_TYPE') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }
    db.updateUser(chatId, { state: 'WAITING_CAPACITY', temp: { ...user.temp, alarmType: 'CAPACITY' } });

    try {
      await bot.editMessageText('📊 *Kapasite Alarmı* seçildi.\n\nOtobüste kaç boş koltuk veya daha azı kaldığında haber verelim?\n(Örn: 5 yazarsanız 5 veya daha az koltuk kaldığında uyarı alırsınız)', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ İptal', callback_data: 'action_cancel' }]]
        }
      });
    } catch (e) { }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data === 'alarm_empty') {
    const user = db.getUser(chatId);
    if (user.state !== 'WAITING_ALARM_TYPE') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu işlem artık geçerli değil.' });
      return;
    }

    const alarms = db.getUserAlarms(chatId);
    if (alarms.length >= 3) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'En fazla 3 adet izleyici kurabilirsiniz. Lütfen /listem menüsünden silin.', show_alert: true });
      return;
    }
    const exists = alarms.find(a => a.journeyId === user.temp.journeyId && a.type === 'ANY_SEAT_EMPTY');
    if (exists) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bu sefer için zaten Koltuk Boşalma alarmınız var!', show_alert: true });
      return;
    }

    db.addAlarm({
      chatId: chatId,
      type: 'ANY_SEAT_EMPTY',
      capacityLimit: null,
      seatNum: null,
      soldSeats: user.temp.soldSeats,
      initialAvailable: user.temp.initialAvailable,
      journeyId: user.temp.journeyId,
      originId: user.temp.originId,
      destinationId: user.temp.destinationId,
      date: user.temp.date,
      busName: user.temp.busName,
      departure: user.temp.departure
    });
    db.updateUser(chatId, { state: 'IDLE', temp: {} });

    try {
      await bot.editMessageText(
        `✅ *Koltuk Boşalma Alarmı Kuruldu!*\n\n${user.temp.date} tarihindeki ${user.temp.busName} seferinde herhangi bir bilet iptal edilip boş koltuk açıldığında size haber vereceğim.`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `✅ *Koltuk Boşalma Alarmı Kuruldu!*\n\n${user.temp.date} tarihindeki ${user.temp.busName} seferinde herhangi bir bilet iptal edilip boş koltuk açıldığında size haber vereceğim.`, { parse_mode: 'Markdown' });
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Alarm kuruldu!' });
    return;
  }

  // Aksiyon butonları

  // Alarm Silme İşlemi
  if (data.startsWith('alarm_delete_')) {
    const alarmId = data.replace('alarm_delete_', '');
    db.removeAlarm(alarmId);

    // Refresh list
    const alarms = db.getUserAlarms(chatId);
    if (alarms.length === 0) {
      bot.editMessageText('Şu anda aktif bir izlemeniz bulunmuyor.', { chat_id: chatId, message_id: messageId });
    } else {
      let txt = '📝 *Aktif İzlemeleriniz:*\n\n';
      const inline_keyboard = [];
      alarms.forEach((a, i) => {
        txt += `${i + 1}. *${a.busName}* - ${a.date} ${a.departure}\n`;
        if (a.type === 'CAPACITY') {
          txt += `   └ Kapasite: ${a.capacityLimit} veya daha az koltuk kalınca.\n`;
        } else if (a.type === 'ANY_SEAT_EMPTY') {
          txt += `   └ Koltuk boşaldığında.\n`;
        }
        inline_keyboard.push([{ text: `❌ ${i + 1}. İzleyiciyi Sil`, callback_data: `alarm_delete_${a.id}` }]);
      });
      bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'İzleyici silindi.' });
    return;
  }

  if (data === 'action_cancel') {
    db.updateUser(chatId, { state: 'IDLE', temp: {} });
    setProcessing(chatId, false);
    try {
      await bot.editMessageText('👋 Ana menüye dönüldü. Yeni bir işlem için /sefer komutunu kullanabilirsiniz.', {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (e) {
      bot.sendMessage(chatId, '👋 Ana menüye dönüldü. Yeni bir işlem için /sefer komutunu kullanabilirsiniz.');
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data === 'action_change_date') {
    const user = db.getUser(chatId);
    const mode = (user.temp && user.temp.mode) || 'SEFER';
    db.updateUser(chatId, {
      state: 'WAITING_DATE',
      temp: { ...user.temp, mode }
    });

    const { year, month } = calendar.getCurrentMonthYear();
    const calendarMarkup = calendar.generateCalendar(year, month);

    try {
      await bot.editMessageText(
        `📅 *${user.temp.originName} → ${user.temp.destName}*\n\nGitmek istediğiniz tarihi seçin:`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: calendarMarkup }
      );
    } catch (e) {
      bot.sendMessage(chatId, `📅 *${user.temp.originName} → ${user.temp.destName}*\n\nGitmek istediğiniz tarihi seçin:`, {
        parse_mode: 'Markdown',
        reply_markup: calendarMarkup
      });
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data === 'action_change_origin') {
    const user = db.getUser(chatId);
    const mode = (user.temp && user.temp.mode) || 'SEFER';
    try {
      await bot.editMessageText('📍 Nereden yola çıkacaksınız? (şehir veya ilçe adı)', {
        chat_id: chatId,
        message_id: messageId
      });
      db.updateUser(chatId, { state: 'WAITING_ORIGIN', temp: { mode, promptMsgId: messageId } });
    } catch (e) {
      const msg = await bot.sendMessage(chatId, '📍 Nereden yola çıkacaksınız? (şehir veya ilçe adı)');
      db.updateUser(chatId, { state: 'WAITING_ORIGIN', temp: { mode, promptMsgId: msg.message_id } });
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data === 'action_change_dest') {
    const user = db.getUser(chatId);
    const mode = (user.temp && user.temp.mode) || 'SEFER';
    try {
      await bot.editMessageText(`✅ Nereden: *${user.temp.originName}*\n\n📍 Nereye gideceksiniz?`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
      db.updateUser(chatId, {
        state: 'WAITING_DEST',
        temp: { mode, originId: user.temp.originId, originName: user.temp.originName, promptMsgId: messageId }
      });
    } catch (e) {
      const msg = await bot.sendMessage(chatId, `✅ Nereden: *${user.temp.originName}*\n\n📍 Nereye gideceksiniz?`, { parse_mode: 'Markdown' });
      db.updateUser(chatId, {
        state: 'WAITING_DEST',
        temp: { mode, originId: user.temp.originId, originName: user.temp.originName, promptMsgId: msg.message_id }
      });
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Fuse.js önerisi seçimi: city_fuse_origin_INDEX veya city_fuse_dest_INDEX
  if (data.startsWith('city_fuse_')) {
    const parts = data.split('_');
    const phase = parts[2]; // 'origin' veya 'dest'
    const index = parseInt(parts[3]);
    const user = db.getUser(chatId);

    if (!user.temp.fuseSuggestions || !user.temp.fuseSuggestions[index]) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Geçersiz seçim.' });
      return;
    }

    if (isProcessing(chatId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'İşlem devam ediyor, bekleyin...' });
      return;
    }

    setProcessing(chatId, true);
    const suggestedName = user.temp.fuseSuggestions[index].name;
    await bot.answerCallbackQuery(callbackQuery.id, { text: `"${suggestedName}" aranıyor...` });

    try {
      // Düzeltilmiş isimle API'den ara
      const results = await obiletApi.searchCity(suggestedName);

      if (results.length > 0) {
        const bestMatch = results[0];

        if (phase === 'origin') {
          bot.deleteMessage(chatId, messageId).catch(() => {});
          const promptMsg = await bot.sendMessage(chatId, `✅ Nereden: *${bestMatch.display}*\n\n📍 Nereye gideceksiniz?`, { parse_mode: 'Markdown' });
          db.updateUser(chatId, {
            state: 'WAITING_DEST',
            temp: { ...user.temp, originId: bestMatch.id, originName: bestMatch.display, fuseSuggestions: undefined, promptMsgId: promptMsg.message_id }
          });
        } else {
          bot.deleteMessage(chatId, messageId).catch(() => {});
          db.updateUser(chatId, {
            state: 'WAITING_DATE',
            temp: { ...user.temp, destinationId: bestMatch.id, destName: bestMatch.display, fuseSuggestions: undefined }
          });

          const { year, month } = calendar.getCurrentMonthYear();
          const calendarMarkup = calendar.generateCalendar(year, month);

          bot.sendMessage(chatId, `📅 *${user.temp.originName} → ${bestMatch.display}*\nGitmek istediğiniz tarihi seçin:`, {
            parse_mode: 'Markdown',
            reply_markup: calendarMarkup
          });
        }
      } else {
        bot.sendMessage(chatId, `❌ "${suggestedName}" için de sonuç bulunamadı. Lütfen farklı bir isim deneyin.`);
        db.updateUser(chatId, {
          state: phase === 'origin' ? 'WAITING_ORIGIN' : 'WAITING_DEST',
          temp: { ...user.temp, fuseSuggestions: undefined }
        });
      }
    } catch (err) {
      console.error('Error in fuse city search:', err);
      bot.sendMessage(chatId, '❌ Arama sırasında hata oluştu. Lütfen tekrar deneyin.');
    } finally {
      setProcessing(chatId, false);
    }
    return;
  }

  // Şehir seçim butonları: city_INDEX_PHASE
  if (data.startsWith('city_')) {
    const parts = data.split('_');
    const index = parseInt(parts[1]);
    const phase = parts[2]; // 'origin' veya 'dest'
    const user = db.getUser(chatId);

    if (!user.temp.cityResults || !user.temp.cityResults[index]) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Geçersiz seçim.' });
      return;
    }

    const selected = user.temp.cityResults[index];
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${selected.display} seçildi` });

    if (phase === 'origin') {
      bot.deleteMessage(chatId, messageId).catch(() => {});
      const promptMsg = await bot.sendMessage(chatId, `✅ Nereden: *${selected.display}*\n\n📍 Nereye gideceksiniz?`, { parse_mode: 'Markdown' });
      db.updateUser(chatId, {
        state: 'WAITING_DEST',
        temp: { ...user.temp, originId: selected.id, originName: selected.display, cityResults: undefined, promptMsgId: promptMsg.message_id }
      });
    } else {
      // dest seçildi → takvim göster
      bot.deleteMessage(chatId, messageId).catch(() => {});
      db.updateUser(chatId, {
        state: 'WAITING_DATE',
        temp: { ...user.temp, destinationId: selected.id, destName: selected.display, cityResults: undefined }
      });

      const { year, month } = calendar.getCurrentMonthYear();
      const calendarMarkup = calendar.generateCalendar(year, month);

      bot.sendMessage(chatId, `📅 *${user.temp.originName} → ${selected.display}*\nGitmek istediğiniz tarihi seçin:`, {
        parse_mode: 'Markdown',
        reply_markup: calendarMarkup
      });
    }
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);
});

// ==========================================
// Mesaj Handler (text mesajları)
// ==========================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  bot.deleteMessage(chatId, msg.message_id).catch(() => { });

  if (!text || text.startsWith('/')) return; // Ignore commands here

  const user = db.getUser(chatId);

  // Processing lock kontrolü
  if (isProcessing(chatId)) {
    bot.sendMessage(chatId, '⏳ Önceki isteğiniz işleniyor, lütfen bekleyin...');
    return;
  }

  try {
    // ===== WAITING_ORIGIN =====
    if (user.state === 'WAITING_ORIGIN') {
      setProcessing(chatId, true);
      const statusMsg = await bot.sendMessage(chatId, '🔍 Şehir aranıyor... ⏳');

      const results = await smartCitySearch(text);
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      if (user.temp.promptMsgId) {
        bot.deleteMessage(chatId, user.temp.promptMsgId).catch(() => {});
      }

      const exactMatch = results.find(r => (r.name && r.name.toLowerCase() === text.toLowerCase()) || (r.display && r.display.toLowerCase() === text.toLowerCase()));

      if (results.length === 1 || exactMatch) {
        const bestMatch = exactMatch || results[0];
        const promptMsg = await bot.sendMessage(chatId, `✅ Nereden: *${bestMatch.display}*\n\n📍 Nereye gideceksiniz?`, { parse_mode: 'Markdown' });
        db.updateUser(chatId, {
          state: 'WAITING_DEST',
          temp: { ...user.temp, originId: bestMatch.id, originName: bestMatch.display, promptMsgId: promptMsg.message_id }
        });
      } else if (results.length > 1) {
        // Birden fazla sonuç → butonlarla göster
        const cityButtons = results.slice(0, 5).map((r, i) => ([{
          text: r.display,
          callback_data: `city_${i}_origin`
        }]));
        cityButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

        const promptMsg = await bot.sendMessage(chatId, '📍 Birden fazla sonuç bulundu. Lütfen seçin:', {
          reply_markup: { inline_keyboard: cityButtons }
        });
        db.updateUser(chatId, {
          state: 'WAITING_ORIGIN',
          temp: { ...user.temp, cityResults: results.slice(0, 5), promptMsgId: promptMsg.message_id }
        });
      } else {
        // Hiç sonuç yok → fuse önerisi dene
        const suggestions = cityMatcher.findTopCities(text);
        if (suggestions.length > 0) {
          const sugButtons = suggestions.map((s, i) => ([{
            text: `${s.name}`,
            callback_data: `city_fuse_origin_${i}`
          }]));
          sugButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

          // Fuse önerilerini sakla
          const promptMsg = await bot.sendMessage(chatId, `❌ *"${text}"* bulunamadı. Şunlardan birini mi demek istediniz?`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: sugButtons }
          });
          db.updateUser(chatId, {
            state: 'WAITING_ORIGIN',
            temp: { ...user.temp, fuseSuggestions: suggestions, promptMsgId: promptMsg.message_id }
          });
        } else {
          const promptMsg = await bot.sendMessage(chatId, '❌ Şehir bulunamadı. Lütfen geçerli bir şehir/ilçe adı yazın.');
          db.updateUser(chatId, { state: 'WAITING_ORIGIN', temp: { ...user.temp, promptMsgId: promptMsg.message_id } });
        }
      }
      setProcessing(chatId, false);
    }
    // ===== WAITING_DEST =====
    else if (user.state === 'WAITING_DEST') {
      setProcessing(chatId, true);
      const statusMsg = await bot.sendMessage(chatId, '🔍 Şehir aranıyor... ⏳');

      const results = await smartCitySearch(text);
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      if (user.temp.promptMsgId) {
        bot.deleteMessage(chatId, user.temp.promptMsgId).catch(() => {});
      }

      const exactMatch = results.find(r => (r.name && r.name.toLowerCase() === text.toLowerCase()) || (r.display && r.display.toLowerCase() === text.toLowerCase()));

      if (results.length === 1 || exactMatch) {
        const bestMatch = exactMatch || results[0];
        db.updateUser(chatId, {
          state: 'WAITING_DATE',
          temp: { ...user.temp, destinationId: bestMatch.id, destName: bestMatch.display }
        });

        const { year, month } = calendar.getCurrentMonthYear();
        const calendarMarkup = calendar.generateCalendar(year, month);

        bot.sendMessage(chatId, `📅 *${user.temp.originName} → ${bestMatch.display}*\nGitmek istediğiniz tarihi seçin:`, {
          parse_mode: 'Markdown',
          reply_markup: calendarMarkup
        });
      } else if (results.length > 1) {
        const cityButtons = results.slice(0, 5).map((r, i) => ([{
          text: r.display,
          callback_data: `city_${i}_dest`
        }]));
        cityButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

        const promptMsg = await bot.sendMessage(chatId, '📍 Birden fazla sonuç bulundu. Lütfen seçin:', {
          reply_markup: { inline_keyboard: cityButtons }
        });
        db.updateUser(chatId, {
          state: 'WAITING_DEST',
          temp: { ...user.temp, cityResults: results.slice(0, 5), promptMsgId: promptMsg.message_id }
        });
      } else {
        const suggestions = cityMatcher.findTopCities(text);
        if (suggestions.length > 0) {
          const sugButtons = suggestions.map((s, i) => ([{
            text: `${s.name}`,
            callback_data: `city_fuse_dest_${i}`
          }]));
          sugButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

          const promptMsg = await bot.sendMessage(chatId, `❌ *"${text}"* bulunamadı. Şunlardan birini mi demek istediniz?`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: sugButtons }
          });
          db.updateUser(chatId, {
            state: 'WAITING_DEST',
            temp: { ...user.temp, fuseSuggestions: suggestions, promptMsgId: promptMsg.message_id }
          });
        } else {
          const promptMsg = await bot.sendMessage(chatId, '❌ Şehir bulunamadı. Lütfen geçerli bir şehir/ilçe adı yazın.');
          db.updateUser(chatId, { state: 'WAITING_DEST', temp: { ...user.temp, promptMsgId: promptMsg.message_id } });
        }
      }
      setProcessing(chatId, false);
    }
    // ===== WAITING_DATE - kullanıcı text yazarsa =====
    else if (user.state === 'WAITING_DATE') {
      // Takvim kullanması lazım ama text yazmışsa yine de kabul edelim
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (dateRegex.test(text)) {
        // Geçerli format, tarih olarak kabul et
        setProcessing(chatId, true);
        const statusMsg = await bot.sendMessage(chatId, 'Seferler aranıyor, lütfen bekleyin... ⏳');

        const journeys = await obiletApi.getJourneys(user.temp.originId, user.temp.destinationId, text);
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

        if (journeys.length === 0) {
          const errorMarkup = getErrorButtons(user);
          bot.sendMessage(chatId,
            `❌ *${calendar.formatDateTurkish(text)}* tarihinde sefer bulunamadı.\n\nNe yapmak istersiniz?`,
            { parse_mode: 'Markdown', reply_markup: errorMarkup }
          );
          db.updateUser(chatId, { state: 'WAITING_ACTION', temp: { ...user.temp, date: text } });
          setProcessing(chatId, false);
          return;
        }

        const topJourneys = journeys.slice(0, 10);
        let listTxt = `🚌 *${user.temp.originName} → ${user.temp.destName}*\n📅 ${calendar.formatDateTurkish(text)}\n\n`;

        const journeyMap = {};
        const journeyButtons = [];

        topJourneys.forEach((j, index) => {
          const num = index + 1;
          journeyMap[num] = j;
          const departureTime = j.journey.departure.split('T')[1].substring(0, 5);
          const price = j.journey['internet-price'];
          const partnerName = j['partner-name'] || 'Firma';

          listTxt += `*${num}.* 🏢 ${partnerName}\n    🕐 ${departureTime} • 💰 ${price} TL\n\n`;

          journeyButtons.push([{
            text: `${num}. ${partnerName} - ${departureTime} (${price} TL)`,
            callback_data: `journey_${num}`
          }]);
        });

        journeyButtons.push([{ text: '❌ İptal', callback_data: 'action_cancel' }]);

        db.updateUser(chatId, {
          state: 'WAITING_JOURNEY',
          temp: { ...user.temp, date: text, journeyMap }
        });

        bot.sendMessage(chatId, listTxt + 'Lütfen bir sefer seçin:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: journeyButtons }
        });
        setProcessing(chatId, false);
      } else {
        bot.sendMessage(chatId, '📅 Lütfen yukarıdaki takvimden bir tarih seçin veya YYYY-MM-DD formatında yazın.');
      }
    }
    // ===== WAITING_CAPACITY =====
    else if (user.state === 'WAITING_CAPACITY') {
      const limit = parseInt(text);
      if (isNaN(limit) || limit <= 0) {
        bot.sendMessage(chatId, 'Lütfen geçerli bir sayı girin. (Örn: 5)', {
          reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'action_cancel' }]] }
        });
        return;
      }

      const currentEmpty = user.temp.initialAvailable || 0;
      if (currentEmpty === 0) {
        bot.sendMessage(chatId, 'Otobüs zaten tamamen dolu. Boş koltuk açıldığında haber almak için "Herhangi bir koltuk boşaldığında bildirim al" seçeneğini kullanabilirsiniz.', {
          reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'action_cancel' }]] }
        });
        return;
      }

      if (limit >= currentEmpty) {
        bot.sendMessage(chatId, `Zaten otobüste şu an ${currentEmpty} boş koltuk var. Lütfen şu anki boş koltuk sayısından daha az bir sayı girin.`, {
          reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'action_cancel' }]] }
        });
        return;
      }

      const alarms = db.getUserAlarms(chatId);
      if (alarms.length >= 3) {
        bot.sendMessage(chatId, 'En fazla 3 adet izleyici kurabilirsiniz. Lütfen /listem komutuyla silin.');
        db.updateUser(chatId, { state: 'IDLE', temp: {} });
        return;
      }
      const exists = alarms.find(a => a.journeyId === user.temp.journeyId && a.type === 'CAPACITY');
      if (exists) {
        bot.sendMessage(chatId, 'Bu sefer için zaten Kapasite alarmınız var!');
        db.updateUser(chatId, { state: 'IDLE', temp: {} });
        return;
      }

      db.addAlarm({
        chatId: chatId,
        type: user.temp.alarmType,
        capacityLimit: limit,
        seatNum: null,
        journeyId: user.temp.journeyId,
        originId: user.temp.originId,
        destinationId: user.temp.destinationId,
        date: user.temp.date,
        busName: user.temp.busName,
        departure: user.temp.departure
      });

      db.updateUser(chatId, { state: 'IDLE', temp: {} });
      bot.sendMessage(chatId, `✅ *Kapasite Alarmı Kuruldu!*\n\n${user.temp.date} tarihindeki ${user.temp.busName} seferinde boş koltuk sayısı ${limit} ve altına düştüğünde size haber vereceğim.`, { parse_mode: 'Markdown' });
    }
    // ===== WAITING_SEAT_NUM =====
    else if (user.state === 'WAITING_SEAT_NUM') {
      const seat = text.trim();

      db.addAlarm({
        chatId: chatId,
        type: user.temp.alarmType,
        capacityLimit: null,
        seatNum: seat,
        journeyId: user.temp.journeyId,
        originId: user.temp.originId,
        destinationId: user.temp.destinationId,
        date: user.temp.date,
        busName: user.temp.busName,
        departure: user.temp.departure
      });

      db.updateUser(chatId, { state: 'IDLE', temp: {} });
      const action = user.temp.alarmType === 'SEAT_EMPTY' ? 'boşaldığında' : 'satıldığında';
      bot.sendMessage(chatId, `✅ *Koltuk Alarmı Kuruldu!*\n\n${user.temp.date} tarihindeki ${user.temp.busName} seferindeki *${seat}* numaralı koltuk ${action} size haber vereceğim.`, { parse_mode: 'Markdown' });
    }

  } catch (error) {
    console.error('Error handling message:', error);
    setProcessing(chatId, false);
    bot.sendMessage(chatId, '❌ Bir hata oluştu.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Tekrar Dene', callback_data: 'action_change_origin' }],
          [{ text: '❌ İptal', callback_data: 'action_cancel' }]
        ]
      }
    });
    db.updateUser(chatId, { state: 'WAITING_ACTION', temp: user.temp || {} });
  }
});

console.log('Telegram Bot started successfully.');
