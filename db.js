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

function getUser(chatId) {
  const db = readDB();
  if (!db.users[chatId]) {
    db.users[chatId] = { state: 'IDLE', temp: {} };
    writeDB(db);
  }
  return db.users[chatId];
}

function updateUser(chatId, data) {
  const db = readDB();
  db.users[chatId] = { ...db.users[chatId], ...data };
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

function getAlarms() {
  const db = readDB();
  return db.alarms || [];
}

function getUserAlarms(chatId) {
  const db = readDB();
  return (db.alarms || []).filter(a => a.chatId === chatId);
}

module.exports = {
  getUser,
  updateUser,
  addAlarm,
  removeAlarm,
  getAlarms,
  getUserAlarms
};
