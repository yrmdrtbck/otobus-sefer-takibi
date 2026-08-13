const obiletApi = require('./obilet-api');
const db = require('./db');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function checkAlarms(bot) {
  console.log('[Watcher] Checking alarms at', new Date().toISOString());
  const alarms = db.getAlarms();
  if (alarms.length === 0) {
    console.log('[Watcher] No active alarms.');
    return;
  }

  // Group alarms by journeyId to minimize API calls
  const journeysToFetch = {};
  for (const alarm of alarms) {
    if (!journeysToFetch[alarm.journeyId]) {
      journeysToFetch[alarm.journeyId] = [];
    }
    journeysToFetch[alarm.journeyId].push(alarm);
  }

  for (const journeyId in journeysToFetch) {
    const journeyAlarms = journeysToFetch[journeyId];
    // Pick origin/dest/date from the first alarm
    const { originId, destinationId, date } = journeyAlarms[0];

    try {
      console.log(`[Watcher] Fetching details for journey ${journeyId}`);
      const details = await obiletApi.getJourneyDetails(journeyId, originId, destinationId, date);
      
      if (details && details.bus) {
        const seats = obiletApi.parseSeats(details.bus);
        
        for (const alarm of journeyAlarms) {
          let triggered = false;
          let message = '';

          if (alarm.type === 'ANY_SEAT_EMPTY') {
            const initialSoldSeats = alarm.soldSeats || [];
            
            // Check if any seat in initialSoldSeats is currently available
            const emptiedSeats = initialSoldSeats.filter(seatNum => {
              const currentSeat = seats.find(s => s.number === seatNum);
              return currentSeat && currentSeat.available;
            });

            if (emptiedSeats.length > 0) {
              triggered = true;
              message = `🚍 *Koltuk Boşaldı!*\n\n${alarm.date} tarihindeki *${alarm.busName}* firmasının seferinde bilet iptali nedeniyle **${emptiedSeats.join(', ')} numaralı koltuk(lar)** boşaldı!`;
            }
          } else if (alarm.type === 'CAPACITY') {
            const availableCount = seats.filter(s => s.available).length;
            if (availableCount <= alarm.capacityLimit) {
              triggered = true;
              message = `🚍 *Kapasite Alarmı!*\n\n${alarm.date} tarihindeki *${alarm.busName}* firmasının seferinde sadece **${availableCount}** boş koltuk kaldı! (Sınırınız: ${alarm.capacityLimit})`;
            }
          }

          if (triggered) {
            console.log(`[Watcher] Alarm triggered for ${alarm.chatId}`);
            try {
              await bot.sendMessage(alarm.chatId, message, { parse_mode: 'Markdown' });
              db.removeAlarm(alarm.id); // Remove alarm after it's triggered
            } catch (err) {
              console.error('[Watcher] Failed to send telegram message', err);
            }
          }
        }
      } else {
        console.log(`[Watcher] Could not fetch bus data for journey ${journeyId}`);
      }
    } catch (err) {
      console.error(`[Watcher] Error fetching journey ${journeyId}`, err);
    }
  }
}

function startWatcher(bot) {
  console.log('[Watcher] Started polling every 5 minutes.');
  // Initial check
  checkAlarms(bot);
  // Interval
  setInterval(() => checkAlarms(bot), CHECK_INTERVAL_MS);
}

module.exports = {
  startWatcher
};
