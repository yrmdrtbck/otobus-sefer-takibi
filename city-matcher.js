/**
 * Fuzzy şehir eşleştirme modülü
 * Fuse.js kullanarak kullanıcının hatalı yazdığı şehir isimlerini düzeltir.
 */

const Fuse = require('fuse.js');

// Türkiye'nin 81 ili + yaygın kullanılan büyük ilçeler
const CITIES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara',
  'Antalya', 'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman',
  'Bayburt', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa',
  'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Düzce',
  'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep',
  'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Iğdır', 'Isparta',
  'İstanbul', 'İzmir', 'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars',
  'Kastamonu', 'Kayseri', 'Kilis', 'Kırıkkale', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Mardin',
  'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye',
  'Rize', 'Sakarya', 'Samsun', 'Şanlıurfa', 'Siirt', 'Sinop', 'Sivas',
  'Şırnak', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Uşak', 'Van',
  'Yalova', 'Yozgat', 'Zonguldak',
  // Büyük ilçeler
  'İskenderun', 'Antakya', 'Alanya', 'Manavgat', 'Side', 'Bodrum', 'Marmaris',
  'Fethiye', 'Kuşadası', 'Didim', 'Çeşme', 'Bergama', 'Akhisar', 'Tarsus',
  'Silifke', 'Erdemli', 'Anamur', 'Dalaman', 'Ortaca', 'Milas', 'Söke',
  'Nazilli', 'Bolu', 'Mudanya', 'Gemlik', 'İnegöl', 'Bandırma', 'Erdek',
  'Gönen', 'Biga', 'Çan', 'Lapseki', 'Gelibolu', 'Keşan', 'Uzunköprü',
  'Lüleburgaz', 'Babaeski', 'Çorlu', 'Çerkezköy', 'Saray', 'Adapazarı',
  'Gebze', 'İzmit', 'Derince', 'Gölcük', 'Karasu', 'Hendek', 'Akyazı',
  'Bafra', 'Çarşamba', 'Terme', 'Ünye', 'Fatsa', 'Perşembe', 'Giresun',
  'Tirebolu', 'Görele', 'Espiye', 'Of', 'Araklı', 'Sürmene', 'Çaykara',
  'Rize', 'Çamlıhemşin', 'Ardeşen', 'Pazar', 'Hopa', 'Arhavi', 'Borçka',
  'Artvin', 'Yusufeli', 'Şavşat', 'Ardahan', 'Göle', 'Çıldır', 'Posof',
  'Kağızman', 'Sarıkamış', 'Iğdır', 'Doğubayazıt', 'Patnos', 'Erciş',
  'Tatvan', 'Ahlat', 'Bitlis', 'Cizre', 'Silopi', 'Nusaybin', 'Midyat',
  'Kızıltepe', 'Viranşehir', 'Suruç', 'Birecik', 'Halfeti', 'Nizip',
  'İslahiye', 'Nurdağı', 'Kahta', 'Gölbaşı', 'Besni', 'Elbistan',
  'Afşin', 'Göksun', 'Pazarcık', 'Türkoğlu', 'Osmaniye', 'Kadirli',
  'Düziçi', 'Kozan', 'Ceyhan', 'Karataş', 'Yüreğir', 'Pozantı',
  'Develi', 'Bünyan', 'Pınarbaşı', 'Sarız', 'Tomarza', 'Yahyalı',
  'Ürgüp', 'Avanos', 'Göreme', 'Aksaray', 'Niğde', 'Bor', 'Ulukışla',
  'Ereğli', 'Karaman', 'Cihanbeyli', 'Kulu', 'Akşehir', 'Beyşehir',
  'Seydişehir', 'Ilgın', 'Kadınhanı', 'Çumra', 'Karapınar',
  'Afyon', 'Sandıklı', 'Dinar', 'Emirdağ', 'Bolvadin', 'Çay', 'Şuhut',
  'Kütahya', 'Tavşanlı', 'Simav', 'Emet', 'Gediz', 'Domaniç',
  'Bilecik', 'Bozüyük', 'Söğüt', 'Eskişehir', 'Sivrihisar', 'Mihalıççık',
  'Polatlı', 'Haymana', 'Beypazarı', 'Nallıhan', 'Çubuk', 'Kalecik',
  'Kızılcahamam', 'Şereflikoçhisar', 'Elmadağ', 'Çankırı', 'Çerkeş',
  'Ilgaz', 'Kurşunlu', 'Kastamonu', 'Tosya', 'Taşköprü', 'İnebolu',
  'Sinop', 'Boyabat', 'Ayancık', 'Gerze', 'Çorum', 'Sungurlu',
  'Osmancık', 'İskilip', 'Alaca', 'Amasya', 'Merzifon', 'Suluova',
  'Gümüşhacıköy', 'Tokat', 'Turhal', 'Erbaa', 'Niksar', 'Zile',
  'Sivas', 'Şarkışla', 'Gemerek', 'Kangal', 'Divriği', 'Zara',
  'Erzincan', 'Tercan', 'Erzurum', 'Tortum', 'Oltu', 'Olur', 'Narman',
  'Pasinler', 'Horasan', 'Aşkale', 'Bayburt', 'Gümüşhane', 'Kelkit',
  'Torul', 'Şiran', 'Malatya', 'Darende', 'Doğanşehir', 'Akçadağ',
  'Elazığ', 'Kovancılar', 'Karakoçan', 'Palu', 'Bingöl', 'Genç',
  'Karlıova', 'Solhan', 'Tunceli', 'Hozat', 'Ovacık', 'Pertek',
  'Muş', 'Malazgirt', 'Bulanık', 'Varto', 'Hakkari', 'Yüksekova',
  'Şemdinli', 'Çukurca', 'Diyarbakır', 'Ergani', 'Çermik', 'Dicle',
  'Lice', 'Kulp', 'Silvan', 'Bismil', 'Batman', 'Sason', 'Kozluk',
  'Siirt', 'Pervari', 'Kurtalan', 'Baykan', 'Şırnak', 'Uludere', 'Beytüşşebap'
];

// Fuse.js ayarları - düşük threshold = daha sıkı eşleşme
const fuseOptions = {
  includeScore: true,
  threshold: 0.4,  // 0.0 = tam eşleşme, 1.0 = her şey eşleşir
  distance: 100,
  minMatchCharLength: 2,
  keys: ['name']
};

const cityList = CITIES.map(c => ({ name: c }));
const fuse = new Fuse(cityList, fuseOptions);

/**
 * Kullanıcının girdiği metni fuzzy match ile en yakın şehre eşleştirir.
 * @param {string} input - Kullanıcının yazdığı şehir ismi
 * @returns {string|null} - Düzeltilmiş şehir ismi veya null
 */
function findClosestCity(input) {
  if (!input || input.trim().length < 2) return null;
  
  const results = fuse.search(input.trim());
  if (results.length > 0 && results[0].score < 0.4) {
    return results[0].item.name;
  }
  return null;
}

/**
 * En yakın 3 şehir önerisini döndürür.
 * @param {string} input 
 * @returns {Array<{name: string, score: number}>}
 */
function findTopCities(input) {
  if (!input || input.trim().length < 2) return [];
  
  const results = fuse.search(input.trim());
  return results.slice(0, 3).map(r => ({
    name: r.item.name,
    score: r.score
  }));
}

module.exports = {
  findClosestCity,
  findTopCities
};
