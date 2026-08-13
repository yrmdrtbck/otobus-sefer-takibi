const cheerio = require('cheerio');
const nodeHtmlToImage = require('node-html-to-image');
const fs = require('fs');
const path = require('path');

const cookieStore = new Map();

const defaultCookieStr = `ob_Culture=%7B%22name%22%3A%22tr-TR%22%2C%22url-prefix%22%3A%22tr%22%2C%22dotnet-culture-name%22%3A%22tr-TR%22%2C%22translation-name%22%3A%22tr-TR%22%2C%22reference-code%22%3A%22TR%22%2C%22use-dot-as-seperator%22%3Afalse%7D; ob_Currency=TRY; ob_DeviceType=Desktop`;

function parseAndStoreCookies(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie');
  if (setCookies) {
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    list.forEach(c => {
      const part = c.split(';')[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        const key = part.substring(0, eqIdx).trim();
        const val = part.substring(eqIdx + 1).trim();
        cookieStore.set(key, val);
      }
    });
  }
}

function getCookieHeader() {
  const defaultMap = new Map();
  defaultCookieStr.split(';').forEach(c => {
    const parts = c.trim().split('=');
    if (parts.length >= 2) {
      defaultMap.set(parts[0], parts.slice(1).join('='));
    }
  });
  cookieStore.forEach((v, k) => {
    defaultMap.set(k, v);
  });
  return Array.from(defaultMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function ensureSession(refererUrl) {
  try {
    const res = await fetch(refererUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cookie": getCookieHeader()
      }
    });
    parseAndStoreCookies(res);
  } catch (err) {
    console.warn('[ObiletAPI] Session init warning:', err.message);
  }
}

async function initBrowser() {
  // Kept for backward compatibility. Browser initialization is no longer needed!
  return true;
}

async function searchCity(query) {
  try {
    const res = await fetch("https://www.obilet.com/json/duraklar", {
      headers: {
        "Accept": "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": getCookieHeader()
      },
      body: JSON.stringify({ query: query, page: 1, element: "destination" }),
      method: "POST"
    });
    parseAndStoreCookies(res);
    const data = await res.json();
    return data.items || [];
  } catch (err) {
    console.error('[ObiletAPI] searchCity error:', err.message);
    return [];
  }
}

async function getJourneys(originId, destinationId, date) {
  const refererUrl = `https://www.obilet.com/seferler/${originId}-${destinationId}/${date}`;
  await ensureSession(refererUrl);

  const url = `https://www.obilet.com/json/journeys/${originId}-${destinationId}/${date}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/json",
        "Referer": refererUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": getCookieHeader()
      },
      body: "{}",
      method: "POST"
    });
    parseAndStoreCookies(res);
    const data = await res.json();
    if (data && data.journeys) return data.journeys;
    if (data && data.data && data.data.journeys) return data.data.journeys;
    return [];
  } catch (err) {
    console.error('[ObiletAPI] getJourneys error:', err.message);
    return [];
  }
}

async function getJourneyDetails(journeyId, originId, destinationId, date) {
  const refererUrl = `https://www.obilet.com/seferler/${originId}-${destinationId}/${date}/${journeyId}?giris`;
  await ensureSession(refererUrl);

  const url = `https://www.obilet.com/json/sefer/${journeyId}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Referer": refererUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": getCookieHeader()
      },
      body: "{}",
      method: "POST"
    });
    parseAndStoreCookies(res);
    return await res.json();
  } catch (err) {
    console.error('[ObiletAPI] getJourneyDetails error:', err.message);
    return { error: true, message: err.message };
  }
}

function parseSeats(svgStr) {
  if (!svgStr) return [];
  const $ = cheerio.load(svgStr, { xmlMode: true });
  const seats = [];
  $('a[obilet\\:seat]').each((i, el) => {
    const seatNum = $(el).attr('obilet:seat');
    const classes = $(el).attr('class') || '';
    const isAvailable = classes.includes('available') && !classes.includes('sold');
    const isSingleSeat = classes.includes('single-seat');
    
    let gender = null;
    if (classes.includes('male') && !classes.includes('female')) {
      gender = 'male';
    } else if (classes.includes('female')) {
      gender = 'female';
    }
    
    const useEl = $(el).find('use');
    const x = parseInt(useEl.attr('x')) || 0;
    const y = parseInt(useEl.attr('y')) || 0;
    
    seats.push({
      number: seatNum,
      available: isAvailable,
      classes: classes,
      gender: gender,
      isSingleSeat: isSingleSeat,
      x: x,
      y: y
    });
  });
  return seats;
}

function generateBusLayoutText(seats) {
  if (!seats || seats.length === 0) return '';

  const columns = {};
  seats.forEach(seat => {
    if (!columns[seat.x]) columns[seat.x] = [];
    columns[seat.x].push(seat);
  });

  const sortedXValues = Object.keys(columns).map(Number).sort((a, b) => a - b);
  const allYValues = [...new Set(seats.map(s => s.y))].sort((a, b) => a - b);

  const yGroups = [];
  let lastY = -100;
  allYValues.forEach(yVal => {
    if (yVal - lastY > 60) {
      yGroups.push([yVal]);
    } else {
      yGroups[yGroups.length - 1].push(yVal);
    }
    lastY = yVal;
  });

  let textGrid = '```\n';
  textGrid += 'Nav\n';

  yGroups.forEach((group, groupIdx) => {
    group.forEach(yVal => {
      let rowStr = '';
      sortedXValues.forEach(xVal => {
        const seat = (columns[xVal] || []).find(s => s.y === yVal);
        if (seat) {
          const numStr = String(seat.number).padStart(2, '0');
          let icon = '🟢';
          if (!seat.available) {
            if (seat.gender === 'male') icon = '👨';
            else if (seat.gender === 'female') icon = '👩';
            else icon = '⬛';
          }
          rowStr += `[${numStr}${icon}]`;
        } else {
          rowStr += '      ';
        }
      });
      textGrid += rowStr + '\n';
    });
    if (groupIdx < yGroups.length - 1) {
      textGrid += '── Koridor ────────────\n';
    }
  });

  textGrid += '```';
  return textGrid;
}

function formatJourneyCardText({
  partnerName,
  originName,
  destName,
  departureTime,
  date,
  price,
  totalSeats,
  availableSeats,
  seatData
}) {
  const months = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const [y, m, d] = date.split('-').map(Number);
  const days = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
  const dateObj = new Date(y, m - 1, d);
  const dayName = days[dateObj.getDay()];
  const formattedDate = `${d} ${months[m - 1]} ${y}, ${dayName}`;

  const occupancyPercent = totalSeats > 0 ? Math.round(((totalSeats - availableSeats) / totalSeats) * 100) : 0;
  const availablePercent = 100 - occupancyPercent;

  let statusEmoji = '🟢';
  let statusText = 'Müsait';
  if (availablePercent <= 20) {
    statusEmoji = '🔴'; statusText = 'Son Birkaç Koltuk!';
  } else if (availablePercent <= 50) {
    statusEmoji = '🟡'; statusText = 'Dolmak Üzere';
  }

  let text = `🚍 *SEFER DETAYLARI*\n\n`;
  text += `🏢 *Firma:* ${partnerName}\n`;
  text += `📍 *Güzergah:* ${originName} ➔ ${destName}\n`;
  text += `📅 *Tarih:* ${formattedDate}\n`;
  text += `🕐 *Kalkış Saati:* ${departureTime}\n`;
  text += `💰 *Fiyat:* ${price} TL\n\n`;
  text += `${statusEmoji} *Durum:* ${statusText}\n`;
  text += `💺 *Koltuklar:* Boş: ${availableSeats} | Dolu: ${totalSeats - availableSeats} | Toplam: ${totalSeats}\n\n`;

  const seatingGrid = generateBusLayoutText(seatData || []);
  if (seatingGrid) {
    text += `*Otobüs Koltuk Düzeni:*\n${seatingGrid}\n\n`;
  }
  text += `💡 *Açıklama:* 🟢 Boş  👨 Erkek Dolu  👩 Kadın Dolu  ⬛ Dolu`;

  return text;
}

async function renderBusLayout(seats) {
  if (!seats || seats.length === 0) return { html: '', width: 0, height: 0 };

  let maxX = 0;
  let maxY = 0;
  
  seats.forEach(seat => {
      if (seat.x > maxX) maxX = seat.x;
      if (seat.y > maxY) maxY = seat.y;
  });

  let html = '';
  seats.forEach(seat => {
      let statusClass = 'available';
      if (!seat.available) {
          if (seat.gender === 'male') statusClass = 'sold-male';
          else if (seat.gender === 'female') statusClass = 'sold-female';
          else statusClass = 'sold-unknown';
      }
      
      html += `<div class="seat ${statusClass}" style="left: ${seat.x}px; top: ${seat.y}px;">
          ${seat.number}
      </div>`;
  });

  return {
      html: html,
      width: maxX + 50,
      height: maxY + 50
  };
}

async function renderJourneyCard(params) {
  const {
      partnerName,
      originName,
      destName,
      departureTime,
      date,
      price,
      totalSeats,
      availableSeats,
      seatData
  } = params;

  const templatePath = path.join(__dirname, 'templates', 'journey-card.html');
  const htmlTemplate = fs.readFileSync(templatePath, 'utf8');

  const months = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const [y, m, d] = date.split('-').map(Number);
  const days = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
  const dateObj = new Date(y, m - 1, d);
  const dayName = days[dateObj.getDay()];
  const formattedDate = `${d} ${months[m - 1]}`;

  const occupancyPercent = totalSeats > 0 ? Math.round(((totalSeats - availableSeats) / totalSeats) * 100) : 0;
  const availablePercent = 100 - occupancyPercent;
  
  let statusColor = '#10b981';
  let statusText = 'Müsait';
  if (availablePercent <= 20) {
      statusColor = '#e11d48';
      statusText = 'Son Koltuklar!';
  } else if (availablePercent <= 50) {
      statusColor = '#f59e0b';
      statusText = 'Dolmak Üzere';
  }

  const busLayout = await renderBusLayout(seatData || []);

  const content = {
      partnerName: partnerName || 'Firma',
      originName,
      destName,
      departureTime,
      date: formattedDate,
      day: dayName,
      price,
      availableSeats,
      soldSeats: totalSeats - availableSeats,
      totalSeats,
      statusColor,
      statusText,
      availablePercent,
      gridWidth: busLayout.width,
      gridHeight: busLayout.height,
      busLayoutHtml: busLayout.html,
      dateFull: `${d} ${months[m - 1]} ${y}, ${dayName}`
  };

  const imageBuffer = await nodeHtmlToImage({
      html: htmlTemplate,
      content: content,
      puppeteerArgs: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  return imageBuffer;
}

module.exports = {
  initBrowser,
  searchCity,
  getJourneys,
  getJourneyDetails,
  parseSeats,
  generateBusLayoutText,
  formatJourneyCardText,
  renderBusLayout,
  renderJourneyCard
};
