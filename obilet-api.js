const cheerio = require('cheerio');
const { Resvg } = require('@resvg/resvg-js');
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
    const isSingleSeat = classes.includes('single-seat') && !classes.includes('not-single-seat');
    
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

const TURKEY_CITY_COORDS = {
  'adana': { lat: 37.0, lng: 35.3 }, 'adıyaman': { lat: 37.7, lng: 38.2 }, 'afyon': { lat: 38.7, lng: 30.5 },
  'afyonkarahisar': { lat: 38.7, lng: 30.5 }, 'ağrı': { lat: 39.7, lng: 43.0 }, 'amasya': { lat: 40.6, lng: 35.8 },
  'ankara': { lat: 39.9, lng: 32.8 }, 'antalya': { lat: 36.8, lng: 30.7 }, 'artvin': { lat: 41.1, lng: 41.8 },
  'aydın': { lat: 37.8, lng: 27.8 }, 'balıkesir': { lat: 39.6, lng: 27.8 }, 'bilecik': { lat: 40.1, lng: 29.9 },
  'bingöl': { lat: 38.8, lng: 40.4 }, 'bitlis': { lat: 38.4, lng: 42.1 }, 'bolu': { lat: 40.7, lng: 31.6 },
  'burdur': { lat: 37.7, lng: 30.2 }, 'bursa': { lat: 40.1, lng: 29.0 }, 'çanakkale': { lat: 40.1, lng: 26.4 },
  'çankırı': { lat: 40.6, lng: 33.6 }, 'çorum': { lat: 40.5, lng: 34.9 }, 'denizli': { lat: 37.7, lng: 29.0 },
  'diyarbakır': { lat: 37.9, lng: 40.2 }, 'edirne': { lat: 41.6, lng: 26.5 }, 'elazığ': { lat: 38.6, lng: 39.2 },
  'erzincan': { lat: 39.7, lng: 39.4 }, 'erzurum': { lat: 39.9, lng: 41.2 }, 'eskişehir': { lat: 39.7, lng: 30.5 },
  'gaziantep': { lat: 37.0, lng: 37.3 }, 'giresun': { lat: 40.9, lng: 38.3 }, 'gümüşhane': { lat: 40.4, lng: 39.4 },
  'hakkari': { lat: 37.5, lng: 43.7 }, 'hatay': { lat: 36.2, lng: 36.1 }, 'ısparta': { lat: 37.7, lng: 30.5 },
  'isparta': { lat: 37.7, lng: 30.5 }, 'mersin': { lat: 36.8, lng: 34.6 }, 'içel': { lat: 36.8, lng: 34.6 },
  'istanbul': { lat: 41.0, lng: 28.9 }, 'izmir': { lat: 38.4, lng: 27.1 }, 'kars': { lat: 40.6, lng: 43.0 },
  'kastamonu': { lat: 41.3, lng: 33.7 }, 'kayseri': { lat: 38.7, lng: 35.4 }, 'kırklareli': { lat: 41.7, lng: 27.2 },
  'kırşehir': { lat: 39.1, lng: 34.1 }, 'kocaeli': { lat: 40.7, lng: 29.9 }, 'izmit': { lat: 40.7, lng: 29.9 },
  'konya': { lat: 37.8, lng: 32.4 }, 'kütahya': { lat: 39.4, lng: 29.9 }, 'malatya': { lat: 38.3, lng: 38.3 },
  'manisa': { lat: 38.6, lng: 27.4 }, 'kahramanmaraş': { lat: 37.5, lng: 36.9 }, 'maraş': { lat: 37.5, lng: 36.9 },
  'mardin': { lat: 37.3, lng: 40.7 }, 'muğla': { lat: 37.2, lng: 28.3 }, 'muş': { lat: 38.7, lng: 41.4 },
  'nevşehir': { lat: 38.6, lng: 34.7 }, 'niğde': { lat: 37.9, lng: 34.6 }, 'ordu': { lat: 40.9, lng: 37.8 },
  'rize': { lat: 41.0, lng: 40.5 }, 'sakarya': { lat: 40.7, lng: 30.4 }, 'adapazarı': { lat: 40.7, lng: 30.4 },
  'samsun': { lat: 41.2, lng: 36.3 }, 'siirt': { lat: 37.9, lng: 41.9 }, 'sinop': { lat: 42.0, lng: 35.1 },
  'sivas': { lat: 39.7, lng: 37.0 }, 'tekirdağ': { lat: 40.9, lng: 27.5 }, 'tokat': { lat: 40.3, lng: 36.5 },
  'trabzon': { lat: 41.0, lng: 39.7 }, 'tunceli': { lat: 39.1, lng: 39.5 }, 'şanlıurfa': { lat: 37.1, lng: 38.7 },
  'urfa': { lat: 37.1, lng: 38.7 }, 'uşak': { lat: 38.6, lng: 29.4 }, 'van': { lat: 38.5, lng: 43.3 },
  'yozgat': { lat: 39.8, lng: 34.8 }, 'zonguldak': { lat: 41.4, lng: 31.7 }, 'aksaray': { lat: 38.3, lng: 34.0 },
  'bayburt': { lat: 40.2, lng: 40.2 }, 'karaman': { lat: 37.1, lng: 33.2 }, 'kırıkkale': { lat: 39.8, lng: 33.5 },
  'batman': { lat: 37.8, lng: 41.1 }, 'şırnak': { lat: 37.5, lng: 42.4 }, 'bartın': { lat: 41.6, lng: 32.3 },
  'ardahan': { lat: 41.1, lng: 42.7 }, 'ığdır': { lat: 39.9, lng: 44.0 }, 'yalova': { lat: 40.6, lng: 29.2 },
  'karabük': { lat: 41.2, lng: 32.6 }, 'kilis': { lat: 36.7, lng: 37.1 }, 'osmaniye': { lat: 37.0, lng: 36.2 },
  'düzce': { lat: 40.8, lng: 31.1 }
};

function getCityCoords(name) {
  if (!name) return null;
  const clean = name.toLowerCase().replace(/[^a-zçğıöşü]/g, '');
  for (const k in TURKEY_CITY_COORDS) {
    if (clean.includes(k) || k.includes(clean)) return TURKEY_CITY_COORDS[k];
  }
  return null;
}

function calculateSunPosition(originName, destName, departureTime, arrivalTime) {
  const c1 = getCityCoords(originName);
  const c2 = getCityCoords(destName);
  if (!c1 || !c2) return null;

  const depParts = (departureTime || '12:00').split(':');
  const depHour = parseInt(depParts[0], 10) + parseInt(depParts[1] || 0, 10) / 60;
  let arrHour = arrivalTime ? (parseInt(arrivalTime.split(':')[0], 10) + parseInt(arrivalTime.split(':')[1] || 0, 10) / 60) : (depHour + 6);
  if (arrHour < depHour) arrHour += 24;

  if (depHour >= 21 && arrHour <= 30) return null;

  let midHour = (depHour + arrHour) / 2;
  while (midHour >= 24) midHour -= 24;
  if (midHour < 6 || midHour > 20) {
    if (depHour < 20 && depHour >= 6) midHour = (depHour + 20) / 2;
    else if (arrHour >= 30) midHour = (6 + (arrHour - 24)) / 2;
    else return null;
  }

  const dLat = (c2.lat - c1.lat) * Math.PI / 180;
  const dLng = (c2.lng - c1.lng) * Math.PI / 180;
  const lat1 = c1.lat * Math.PI / 180;
  const lat2 = c2.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLat);
  let busBearing = Math.atan2(y, x) * 180 / Math.PI;
  if (busBearing < 0) busBearing += 360;

  const sunAzimuth = 80 + ((midHour - 6) / 14) * 200;
  let relAngle = (sunAzimuth - busBearing + 360) % 360;

  if (relAngle >= 340 || relAngle < 20) return 'front';
  if (relAngle >= 20 && relAngle < 70) return 'front-right';
  if (relAngle >= 70 && relAngle < 110) return 'right';
  if (relAngle >= 110 && relAngle < 160) return 'back-right';
  if (relAngle >= 160 && relAngle < 200) return 'back';
  if (relAngle >= 200 && relAngle < 250) return 'back-left';
  if (relAngle >= 250 && relAngle < 290) return 'left';
  if (relAngle >= 290 && relAngle < 340) return 'front-left';
  return 'right';
}

const calculateSunSide = calculateSunPosition;

const logoCache = new Map();

async function getPartnerLogoBase64(partnerId) {
  if (!partnerId) return null;
  if (logoCache.has(partnerId)) return logoCache.get(partnerId);

  try {
    const url = `https://s3.eu-central-1.amazonaws.com/static.obilet.com/images/partner/${partnerId}-sm.png`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString('base64');
      logoCache.set(partnerId, base64);
      return base64;
    }
  } catch (err) {
    console.warn(`[ObiletAPI] Logo fetch warning for partner ${partnerId}:`, err.message);
  }
  logoCache.set(partnerId, null);
  return null;
}

function formatJourneyCardText({
  partnerName,
  originName,
  destName,
  departureTime,
  arrivalTime,
  durationStr,
  date,
  price,
  totalSeats,
  availableSeats,
  seatData,
  buyUrl
}) {
  const months = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const [y, m, d] = date.split('-').map(Number);
  const days = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
  const dateObj = new Date(y, m - 1, d);
  const dayName = days[dateObj.getDay()];
  const formattedDate = `${d} ${months[m - 1]} ${y}, ${dayName}`;

  const occupancyPercent = totalSeats > 0 ? Math.round(((totalSeats - availableSeats) / totalSeats) * 100) : 0;

  let statusEmoji = '🟢';
  let statusText = 'Müsait';
  if (totalSeats > 0) {
    if (availableSeats === 0) {
      statusEmoji = '⚫';
      statusText = 'Tükendi';
    } else if (availableSeats <= 7) {
      statusEmoji = '🔴';
      statusText = `Son ${availableSeats} Koltuk!`;
    } else if (availableSeats <= 12 || occupancyPercent >= 70) {
      statusEmoji = '🟠';
      statusText = 'Dolmak Üzere';
    } else if (occupancyPercent >= 40) {
      statusEmoji = '🟡';
      statusText = 'Orta Doluluk';
    }
  }

  let text = `🚍 *SEFER DETAYLARI*\n\n`;
  text += `🏢 *Firma:* ${partnerName}\n`;
  text += `📍 *Güzergah:* ${originName} ➔ ${destName}\n`;
  text += `📅 *Tarih:* ${formattedDate}\n`;
  text += `🕐 *Kalkış Saati:* ${departureTime}${arrivalTime ? `  |  🏁 *Varış:* ~${arrivalTime}` : ''}${durationStr ? ` (${durationStr})` : ''}\n`;
  text += `💰 *Fiyat:* ${price} TL\n\n`;
  text += `${statusEmoji} *Durum:* ${statusText}\n`;
  text += `💺 *Koltuklar:* Boş: ${availableSeats} | Dolu: ${totalSeats - availableSeats} | Toplam: ${totalSeats}\n\n`;

  const seatingGrid = generateBusLayoutText(seatData || []);
  if (seatingGrid) {
    text += `*Otobüs Koltuk Düzeni:*\n${seatingGrid}\n\n`;
  }
  text += `💡 *Açıklama:* 🟢 Boş  👨 Erkek Dolu  👩 Kadın Dolu  ⬛ Dolu`;

  if (buyUrl) {
    text += `\n\n🎟️ [Bileti obilet.com üzerinden satın al](${buyUrl})`;
  }

  return text;
}

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildJourneyCardSvg(params) {
  const {
    partnerName = 'Firma',
    logoBase64 = null,
    originName = 'Kalkış',
    destName = 'Varış',
    departureTime = '00:00',
    arrivalTime = '',
    durationStr = '',
    date = '2026-08-14',
    price = 0,
    totalSeats = 0,
    availableSeats = 0,
    seatData = [],
    sunSide: customSunSide = undefined
  } = params;

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
  let badgeWidth = 120;

  if (totalSeats > 0) {
    if (availableSeats === 0) {
      statusColor = '#dc2626';
      statusText = 'Tükendi';
      badgeWidth = 120;
    } else if (availableSeats <= 7) {
      statusColor = '#e11d48';
      statusText = `Son ${availableSeats} Koltuk!`;
      badgeWidth = 150;
    } else if (availableSeats <= 12 || occupancyPercent >= 70) {
      statusColor = '#ea580c';
      statusText = 'Dolmak Üzere';
      badgeWidth = 150;
    } else if (occupancyPercent >= 40) {
      statusColor = '#d97706';
      statusText = 'Orta Doluluk';
      badgeWidth = 145;
    }
  }

  // Calculate seat coordinates & bounding box
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  if (seatData && seatData.length > 0) {
    minX = Math.min(...seatData.map(s => s.x));
    minY = Math.min(...seatData.map(s => s.y));
    maxX = Math.max(...seatData.map(s => s.x - minX));
    maxY = Math.max(...seatData.map(s => s.y - minY));
  }

  const gridWidth = maxX > 0 ? maxX + 44 : 520;
  const gridHeight = maxY > 0 ? maxY + 42 : 120;

  const busWidth = Math.max(680, gridWidth + 95);
  const busHeight = Math.max(140, gridHeight + 40);

  const cardWidth = Math.max(840, busWidth + 80);
  const busX = (cardWidth - busWidth) / 2;
  const busY = 330;

  const legendY = busY + busHeight + 22;
  const cardHeight = legendY + 36;

  // Partner initials (fallback if logo not available)
  const initials = escapeXml(partnerName.trim().substring(0, 4).toUpperCase());

  // Seats SVG elements
  const seatStartX = busX + 68;
  const seatStartY = busY + 20;

  let seatsSvg = '';
  if (seatData && seatData.length > 0) {
    seatData.forEach(seat => {
      const sx = seatStartX + (seat.x - minX);
      const sy = seatStartY + (seat.y - minY);

      let fill = '#ffffff';
      let stroke = '#cbd5e1';
      let textColor = '#334155';

      if (!seat.available) {
        if (seat.gender === 'male') {
          fill = '#bfdbfe';
          stroke = '#3b82f6';
          textColor = '#1e3a8a';
        } else if (seat.gender === 'female') {
          fill = '#fce7f3';
          stroke = '#f472b6';
          textColor = '#be185d';
        } else {
          fill = '#f1f5f9';
          stroke = '#cbd5e1';
          textColor = '#94a3b8';
        }
      }

      seatsSvg += `
        <rect x="${sx}" y="${sy}" width="44" height="42" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#dropShadow)" />
        <text x="${sx + 22}" y="${sy + 26}" text-anchor="middle" font-family="'Segoe UI', 'Inter', -apple-system, Roboto, sans-serif" font-size="15" font-weight="800" fill="${textColor}">${escapeXml(seat.number)}</text>
      `;
    });
  }

  // Info cards calculations
  const innerMargin = 40;
  const innerWidth = cardWidth - (innerMargin * 2);
  const cardGap = 16;
  const cardItemWidth = (innerWidth - (cardGap * 2)) / 3;

  const card1X = innerMargin;
  const card2X = innerMargin + cardItemWidth + cardGap;
  const card3X = innerMargin + (cardItemWidth + cardGap) * 2;

  // Badges calculations
  const soldSeats = totalSeats - availableSeats;
  const badge3W = 95;
  const badge2W = 85;
  const badge1W = 85;
  const bGap = 8;
  const b3X = cardWidth - innerMargin - badge3W;
  const b2X = b3X - bGap - badge2W;
  const b1X = b2X - bGap - badge1W;

  const logoMarkup = logoBase64
    ? `
      <rect x="36" y="13" width="86" height="50" rx="12" fill="#ffffff" filter="url(#dropShadow)" />
      <image href="data:image/png;base64,${logoBase64}" x="41" y="16" width="76" height="44" preserveAspectRatio="xMidYMid meet" />
      <text class="font-base" x="136" y="45" font-size="22" font-weight="800" fill="#ffffff" letter-spacing="-0.3">${escapeXml(partnerName)}</text>
    `
    : `
      <rect x="36" y="13" width="50" height="50" rx="12" fill="#ffffff" filter="url(#dropShadow)" />
      <text class="font-base" x="61" y="43" text-anchor="middle" font-size="13" font-weight="800" fill="#be123c">${initials}</text>
      <text class="font-base" x="98" y="45" font-size="22" font-weight="800" fill="#ffffff" letter-spacing="-0.3">${escapeXml(partnerName)}</text>
    `;

  const sunPos = customSunSide !== undefined ? customSunSide : calculateSunPosition(originName, destName, departureTime, arrivalTime);
  let sunMarkup = '';
  if (sunPos) {
    let sx = busX + busWidth - 55;
    let sy = busY + busHeight + 3;

    switch (sunPos) {
      case 'front-left':
        sx = busX + 45;
        sy = busY - 22;
        break;
      case 'left':
        sx = busX + busWidth / 2 - 11;
        sy = busY - 22;
        break;
      case 'back-left':
        sx = busX + busWidth - 55;
        sy = busY - 22;
        break;
      case 'front-right':
        sx = busX + 45;
        sy = busY + busHeight + 3;
        break;
      case 'right':
        sx = busX + busWidth / 2 - 11;
        sy = busY + busHeight + 3;
        break;
      case 'back-right':
        sx = busX + busWidth - 55;
        sy = busY + busHeight + 3;
        break;
      case 'front':
        sx = busX - 22;
        sy = busY + busHeight / 2 - 11;
        break;
      case 'back':
        sx = busX + busWidth + 6;
        sy = busY + busHeight / 2 - 11;
        break;
    }

    sunMarkup = `
      <g transform="translate(${sx}, ${sy})">
        <circle cx="11" cy="11" r="5.5" fill="#f59e0b" />
        <path d="M11,1 L11,3.5 M11,18.5 L11,21 M1,11 L3.5,11 M18.5,11 L21,11 M3.9,3.9 L5.7,5.7 M16.3,16.3 L18.1,18.1 M3.9,18.1 L5.7,16.3 M16.3,5.7 L18.1,3.9" stroke="#f59e0b" stroke-width="1.8" stroke-linecap="round" />
      </g>
    `;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${cardWidth}" height="${cardHeight}" viewBox="0 0 ${cardWidth} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#be123c" />
      <stop offset="50%" stop-color="#e11d48" />
      <stop offset="100%" stop-color="#f43f5e" />
    </linearGradient>
    <linearGradient id="routeLeftGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e2e8f0" />
      <stop offset="100%" stop-color="#e11d48" />
    </linearGradient>
    <linearGradient id="routeRightGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e11d48" />
      <stop offset="100%" stop-color="#e2e8f0" />
    </linearGradient>
    <linearGradient id="progressGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
    <filter id="dropShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.06" />
    </filter>
    <clipPath id="cardClip">
      <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="24" ry="24" />
    </clipPath>
  </defs>

  <style>
    .font-base { font-family: 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; }
  </style>

  <!-- Main Card Container -->
  <g clip-path="url(#cardClip)">
    <!-- Base Background -->
    <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5" />

    <!-- 1. Header -->
    <rect x="0" y="0" width="${cardWidth}" height="76" fill="url(#headerGrad)" />
    
    ${logoMarkup}

    <!-- Status Badge -->
    <rect x="${cardWidth - 36 - badgeWidth}" y="19" width="${badgeWidth}" height="38" rx="19" fill="rgba(255, 255, 255, 0.2)" stroke="rgba(255, 255, 255, 0.3)" stroke-width="1" />
    <circle cx="${cardWidth - 36 - badgeWidth + 20}" cy="38" r="5" fill="${statusColor}" stroke="rgba(255,255,255,0.4)" stroke-width="2" />
    <text class="font-base" x="${cardWidth - 36 - badgeWidth + 34}" y="43" font-size="14" font-weight="700" fill="#ffffff">${escapeXml(statusText)}</text>

    <!-- 2. Route Bar -->
    <rect x="0" y="76" width="${cardWidth}" height="78" fill="#ffffff" />
    <line x1="0" y1="154" x2="${cardWidth}" y2="154" stroke="#f1f5f9" stroke-width="1" />

    <!-- Origin -->
    <text class="font-base" x="40" y="103" font-size="11" font-weight="700" fill="#94a3b8" letter-spacing="1.5">KALKIŞ (${escapeXml(departureTime)})</text>
    <text class="font-base" x="40" y="133" font-size="24" font-weight="800" fill="#0f172a" letter-spacing="-0.5">${escapeXml(originName)}</text>

    <!-- Route Center Visual: Duration above bus icon -->
    <g transform="translate(${cardWidth / 2}, 115)">
      ${durationStr ? `<text class="font-base" x="0" y="-12" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8" letter-spacing="1.5">~${escapeXml(durationStr).toUpperCase()}</text>` : ''}
      <line x1="-80" y1="8" x2="-28" y2="8" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="4 3" />
      <g transform="translate(-14, -6)">
        <path d="M4,16C4,17.1 4.9,18 6,18L6,19A1,1 0 0,0 7,20A1,1 0 0,0 8,19L8,18H16L16,19A1,1 0 0,0 17,20A1,1 0 0,0 18,19L18,18C19.1,18 20,17.1 20,16V6C20,3.5 16.41,2 12,2C7.59,2 4,3.5 4,6V16M7.5,13A1.5,1.5 0 0,1 6,11.5A1.5,1.5 0 0,1 7.5,10A1.5,1.5 0 0,1 9,11.5A1.5,1.5 0 0,1 7.5,13M16.5,13A1.5,1.5 0 0,1 15,11.5A1.5,1.5 0 0,1 16.5,10A1.5,1.5 0 0,1 18,11.5A1.5,1.5 0 0,1 16.5,13M18,7H6V4C6,4 7.5,3 12,3C16.5,3 18,4 18,4V7Z" fill="#e11d48" transform="scale(1.1) translate(-2, -2)" />
      </g>
      <line x1="28" y1="8" x2="80" y2="8" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="4 3" />
    </g>

    <!-- Destination -->
    <text class="font-base" x="${cardWidth - 40}" y="103" text-anchor="end" font-size="11" font-weight="700" fill="#94a3b8" letter-spacing="1.5">VARIŞ (${arrivalTime ? '~' + escapeXml(arrivalTime) : '---'})</text>
    <text class="font-base" x="${cardWidth - 40}" y="133" text-anchor="end" font-size="24" font-weight="800" fill="#0f172a" letter-spacing="-0.5">${escapeXml(destName)}</text>

    <!-- 3. Three Info Cards -->
    <!-- Card 1: Departure Time only -->
    <g transform="translate(${card1X}, 168)">
      <rect width="${cardItemWidth}" height="84" rx="16" fill="#ffffff" stroke="#e2e8f0" stroke-width="1" filter="url(#dropShadow)" />
      <path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z" fill="#64748b" transform="translate(${cardItemWidth / 2 - 10}, 10) scale(0.85)" />
      <text class="font-base" x="${cardItemWidth / 2}" y="55" text-anchor="middle" font-size="21" font-weight="800" fill="#0f172a">${escapeXml(departureTime)}</text>
      <text class="font-base" x="${cardItemWidth / 2}" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">Kalkış Saati</text>
    </g>

    <!-- Card 2: Date -->
    <g transform="translate(${card2X}, 168)">
      <rect width="${cardItemWidth}" height="84" rx="16" fill="#ffffff" stroke="#e2e8f0" stroke-width="1" filter="url(#dropShadow)" />
      <path d="M19,19H5V8H19M16,1V3H8V1H6V3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3H18V1M17,12H12V17H17V12Z" fill="#64748b" transform="translate(${cardItemWidth / 2 - 10}, 10) scale(0.85)" />
      <text class="font-base" x="${cardItemWidth / 2}" y="55" text-anchor="middle" font-size="20" font-weight="800" fill="#0f172a">${escapeXml(formattedDate)}</text>
      <text class="font-base" x="${cardItemWidth / 2}" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">${escapeXml(dayName)}</text>
    </g>

    <!-- Card 3: Price -->
    <g transform="translate(${card3X}, 168)">
      <rect width="${cardItemWidth}" height="84" rx="16" fill="#ffffff" stroke="#e2e8f0" stroke-width="1" filter="url(#dropShadow)" />
      <circle cx="${cardItemWidth / 2}" cy="20" r="11" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" />
      <text class="font-base" x="${cardItemWidth / 2}" y="24" text-anchor="middle" font-size="13" font-weight="800" fill="#475569">₺</text>
      <text class="font-base" x="${cardItemWidth / 2}" y="55" text-anchor="middle" font-size="20" font-weight="800" fill="#0f172a">${escapeXml(price)} ₺</text>
      <text class="font-base" x="${cardItemWidth / 2}" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">Bilet Fiyatı</text>
    </g>

    <!-- 4. Seat Status Section Header -->
    <g transform="translate(40, 268)">
      <path d="M4,18V21H7V18H17V21H20V15H4V18M19,10H22V13H19V10M2,10H5V13H2V10M17,13H7V5A2,2 0 0,1 9,3H15A2,2 0 0,1 17,5V13Z" fill="#e11d48" transform="translate(0, 2) scale(0.85)" />
      <text class="font-base" x="26" y="18" font-size="16" font-weight="800" fill="#1e293b">Koltuk Durumu</text>
    </g>

    <!-- Badges -->
    <g transform="translate(${b1X}, 266)">
      <rect width="${badge1W}" height="28" rx="14" fill="#dcfce7" stroke="#bbf7d0" stroke-width="1" />
      <text class="font-base" x="${badge1W / 2}" y="19" text-anchor="middle" font-size="13" font-weight="700" fill="#15803d">Boş: ${availableSeats}</text>
    </g>
    <g transform="translate(${b2X}, 266)">
      <rect width="${badge2W}" height="28" rx="14" fill="#ffe4e6" stroke="#fecdd3" stroke-width="1" />
      <text class="font-base" x="${badge2W / 2}" y="19" text-anchor="middle" font-size="13" font-weight="700" fill="#be123c">Dolu: ${soldSeats}</text>
    </g>
    <g transform="translate(${b3X}, 266)">
      <rect width="${badge3W}" height="28" rx="14" fill="#e0e7ff" stroke="#c7d2fe" stroke-width="1" />
      <text class="font-base" x="${badge3W / 2}" y="19" text-anchor="middle" font-size="13" font-weight="700" fill="#3730a3">Toplam: ${totalSeats}</text>
    </g>

    <!-- Progress Bar -->
    <g transform="translate(40, 305)">
      <rect width="${cardWidth - 80}" height="6" rx="3" fill="#e2e8f0" />
      <rect width="${Math.max(6, (cardWidth - 80) * (availablePercent / 100))}" height="6" rx="3" fill="url(#progressGrad)" />
    </g>

    <!-- 5. Bus Outline -->
    <g transform="translate(${busX}, ${busY})">
      <rect width="${busWidth}" height="${busHeight}" rx="42" fill="#ffffff" stroke="#cbd5e1" stroke-width="2.5" filter="url(#dropShadow)" />
      <!-- Steering Wheel rotated 90 degrees left -->
      <g transform="translate(32, ${busHeight / 2})">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.55.06-1.09.17-1.61l4.88 2.82c-.03.26-.05.52-.05.79 0 1.66 1.34 3 3 3s3-1.34 3-3c0-.27-.02-.53-.05-.79l4.88-2.82c.11.52.17 1.06.17 1.61 0 4.41-3.59 8-8 8zm-6.22-11.45C6.72 6.96 9.17 6 12 6s5.28.96 6.22 2.55L13.5 11.23c-.45-.15-.96-.23-1.5-.23s-1.05.08-1.5.23L5.78 8.55z" fill="#94a3b8" transform="rotate(-90) translate(-16, -16) scale(1.3)" />
      </g>
    </g>

    <!-- Seats rendering -->
    ${seatsSvg}

    <!-- Sun Indicator -->
    ${sunMarkup}

    <!-- 6. Gender Legend -->
    <g transform="translate(${cardWidth / 2 - 160}, ${legendY})">
      <!-- Item 1: Boş -->
      <rect x="0" y="0" width="16" height="16" rx="4" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />
      <text class="font-base" x="22" y="13" font-size="13" font-weight="600" fill="#64748b">Boş Koltuk</text>

      <!-- Item 2: Erkek -->
      <rect x="110" y="0" width="16" height="16" rx="4" fill="#bfdbfe" stroke="#3b82f6" stroke-width="1.5" />
      <text class="font-base" x="132" y="13" font-size="13" font-weight="600" fill="#64748b">Erkek Dolu</text>

      <!-- Item 3: Kadın -->
      <rect x="220" y="0" width="16" height="16" rx="4" fill="#fce7f3" stroke="#f472b6" stroke-width="1.5" />
      <text class="font-base" x="242" y="13" font-size="13" font-weight="600" fill="#64748b">Kadın Dolu</text>
    </g>
  </g>
</svg>`;

  return svg;
}

async function renderBusLayout(seats) {
  // Maintained for backward compatibility
  return { html: '', width: 0, height: 0 };
}

async function renderJourneyCard(params) {
  if (!params.logoBase64 && params.partnerId) {
    params.logoBase64 = await getPartnerLogoBase64(params.partnerId);
  }
  const svg = buildJourneyCardSvg(params);
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'zoom',
      value: 1.5 // Crisp retina quality
    },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Segoe UI'
    }
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = {
  initBrowser,
  searchCity,
  getJourneys,
  getJourneyDetails,
  getPartnerLogoBase64,
  parseSeats,
  generateBusLayoutText,
  formatJourneyCardText,
  buildJourneyCardSvg,
  renderBusLayout,
  renderJourneyCard,
  calculateSunPosition,
  calculateSunSide
};
