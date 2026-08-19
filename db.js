const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'database.json');

const DEFAULT_DB = {
  users: {},
  alarms: []
};

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    writeDB(DEFAULT_DB);
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    return DEFAULT_DB;
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getUser(chatId, from = null) {
  const db = readDB();
  if (!db.users) db.users = {};
  
  if (!db.users[chatId]) {
    db.users[chatId] = {
      state: 'IDLE',
      temp: {},
      username: (from && from.username) ? `@${from.username}` : null,
      firstName: (from && from.first_name) || null,
      lastName: (from && from.last_name) || null,
      updatedAt: new Date().toISOString()
    };
    writeDB(db);
  } else if (from) {
    let updated = false;
    const formattedUsername = from.username ? `@${from.username}` : db.users[chatId].username;
    if (from.username && db.users[chatId].username !== formattedUsername) {
      db.users[chatId].username = formattedUsername;
      updated = true;
    }
    if (from.first_name && db.users[chatId].firstName !== from.first_name) {
      db.users[chatId].firstName = from.first_name;
      updated = true;
    }
    if (from.last_name && db.users[chatId].lastName !== from.last_name) {
      db.users[chatId].lastName = from.last_name;
      updated = true;
    }
    if (updated) {
      db.users[chatId].updatedAt = new Date().toISOString();
      writeDB(db);
    }
  }
  return db.users[chatId];
}

function updateUser(chatId, data, from = null) {
  const db = readDB();
  if (!db.users) db.users = {};
  
  const existing = db.users[chatId] || { state: 'IDLE', temp: {} };
  const username = (from && from.username) ? `@${from.username}` : existing.username;
  const firstName = (from && from.first_name) || existing.firstName;
  const lastName = (from && from.last_name) || existing.lastName;

  db.users[chatId] = {
    ...existing,
    ...data,
    username: username || null,
    firstName: firstName || null,
    lastName: lastName || null,
    updatedAt: new Date().toISOString()
  };
  writeDB(db);
}

function addAlarm(alarm) {
  const db = readDB();
  alarm.id = 'alarm_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  db.alarms.push(alarm);
  writeDB(db);
  return alarm.id;
}

function removeAlarm(id) {
  const db = readDB();
  const index = db.alarms.findIndex(a => a.id === id);
  if (index !== -1) {
    db.alarms.splice(index, 1);
    writeDB(db);
    return true;
  }
  return false;
}

function cleanupExpiredAlarms() {
  const db = readDB();
  if (!db.alarms || db.alarms.length === 0) return [];
  
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const currentHour = now.getHours() + now.getMinutes() / 60;

  const initialCount = db.alarms.length;
  db.alarms = db.alarms.filter(a => {
    if (!a.date) return false;
    if (a.date < todayStr) return false;
    if (a.date === todayStr && a.departure) {
      const depHour = parseInt(a.departure.split(':')[0], 10) + parseInt(a.departure.split(':')[1] || 0, 10) / 60;
      if (currentHour > depHour + 3) return false;
    }
    return true;
  });

  if (db.alarms.length !== initialCount) {
    console.log(`[DB] Cleaned up ${initialCount - db.alarms.length} expired alarm(s).`);
    writeDB(db);
  }
  return db.alarms;
}

function getAlarms() {
  cleanupExpiredAlarms();
  const db = readDB();
  return db.alarms || [];
}

function getUserAlarms(chatId) {
  cleanupExpiredAlarms();
  const db = readDB();
  return (db.alarms || []).filter(a => a.chatId === chatId);
}

module.exports = {
  getUser,
  updateUser,
  addAlarm,
  removeAlarm,
  getAlarms,
  getUserAlarms,
  cleanupExpiredAlarms
};
