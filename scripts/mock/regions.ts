import type { Region } from '../../src/data/types';

/**
 * Searchable regions. Boxes are approximate (rounded Natural-Earth-style extents, ~0.1°);
 * Kazakhstan oblast boxes are rough outlines for the demo, not official boundaries.
 */
type Row = [
  id: string,
  en: string,
  ru: string,
  bbox: [number, number, number, number],
  group: Region['group'],
  aliases?: string[],
  featured?: boolean,
];

const COUNTRIES: Row[] = [
  ['KZ', 'Kazakhstan', 'Казахстан', [46.47, 40.66, 87.36, 55.39], 'central-asia', ['Qazaqstan', 'Kazakstan', 'Қазақстан'], true],
  ['UZ', 'Uzbekistan', 'Узбекистан', [55.93, 37.14, 73.06, 45.59], 'central-asia', ['Ozbekiston', "O'zbekiston"], true],
  ['KG', 'Kyrgyzstan', 'Киргизия', [69.46, 39.28, 80.26, 43.3], 'central-asia', ['Kyrgyz Republic', 'Кыргызстан'], true],
  ['TJ', 'Tajikistan', 'Таджикистан', [67.44, 36.74, 74.98, 40.96], 'central-asia', ['Тоҷикистон']],
  ['TM', 'Turkmenistan', 'Туркменистан', [52.5, 35.27, 66.55, 42.75], 'central-asia', ['Türkmenistan']],
  ['AF', 'Afghanistan', 'Афганистан', [60.53, 29.32, 75.16, 38.49], 'central-asia'],
  ['MN', 'Mongolia', 'Монголия', [87.75, 41.6, 119.77, 52.05], 'central-asia', ['Монгол Улс']],
  ['RU', 'Russia', 'Россия', [19.64, 41.15, 180, 81.25], 'central-asia', ['Russian Federation', 'Российская Федерация']],
  ['CN', 'China', 'Китай', [73.68, 18.2, 134.77, 53.46], 'central-asia', ['PRC']],
  ['IR', 'Iran', 'Иран', [44.11, 25.08, 63.32, 39.71], 'central-asia'],
  ['AZ', 'Azerbaijan', 'Азербайджан', [44.79, 38.27, 50.39, 41.86], 'central-asia', ['Azərbaycan']],
  ['GE', 'Georgia', 'Грузия', [39.96, 41.06, 46.64, 43.55], 'world', ['Sakartvelo']],
  ['AM', 'Armenia', 'Армения', [43.58, 38.74, 46.51, 41.25], 'world', ['Hayastan']],
  ['TR', 'Türkiye', 'Турция', [26.04, 35.82, 44.79, 42.14], 'world', ['Turkey', 'Turkiye']],
  ['UA', 'Ukraine', 'Украина', [22.09, 44.36, 40.08, 52.34], 'world', ['Україна']],
  ['PK', 'Pakistan', 'Пакистан', [60.87, 23.69, 77.84, 37.13], 'world'],
  ['IN', 'India', 'Индия', [68.18, 7.97, 97.4, 35.49], 'world', ['Bharat']],
  ['US', 'United States (contiguous)', 'США (континентальные)', [-124.73, 24.52, -66.95, 49.38], 'world', ['USA', 'America', 'США']],
  ['CA', 'Canada', 'Канада', [-141.0, 41.68, -52.65, 73.23], 'world'],
  ['MX', 'Mexico', 'Мексика', [-117.13, 14.54, -86.81, 32.72], 'world', ['México']],
  ['BR', 'Brazil', 'Бразилия', [-73.99, -33.77, -34.73, 5.24], 'world', ['Brasil']],
  ['BO', 'Bolivia', 'Боливия', [-69.59, -22.9, -57.5, -9.68], 'world'],
  ['AR', 'Argentina', 'Аргентина', [-73.42, -55.25, -53.63, -21.83], 'world'],
  ['AU', 'Australia', 'Австралия', [113.34, -43.63, 153.57, -10.67], 'world'],
  ['ID', 'Indonesia', 'Индонезия', [95.29, -10.36, 141.03, 5.48], 'world'],
  ['CD', 'DR Congo', 'ДР Конго', [12.18, -13.26, 31.17, 5.26], 'world', ['Democratic Republic of the Congo', 'Congo-Kinshasa']],
  ['AO', 'Angola', 'Ангола', [11.64, -17.93, 24.08, -4.44], 'world'],
  ['ZM', 'Zambia', 'Замбия', [21.89, -17.96, 33.49, -8.24], 'world'],
  ['NG', 'Nigeria', 'Нигерия', [2.69, 4.24, 14.58, 13.87], 'world'],
  ['TD', 'Chad', 'Чад', [13.54, 7.42, 23.89, 23.41], 'world', ['Tchad']],
  ['SD', 'Sudan', 'Судан', [21.94, 8.62, 38.41, 22.0], 'world'],
  ['SS', 'South Sudan', 'Южный Судан', [23.89, 3.51, 35.3, 12.25], 'world'],
  ['ZA', 'South Africa', 'ЮАР', [16.34, -34.82, 32.83, -22.09], 'world', ['RSA', 'Южно-Африканская Республика']],
  ['ES', 'Spain', 'Испания', [-9.39, 35.95, 3.04, 43.75], 'world', ['España']],
  ['PT', 'Portugal', 'Португалия', [-9.53, 36.84, -6.39, 42.28], 'world'],
  ['GR', 'Greece', 'Греция', [20.15, 34.92, 26.6, 41.83], 'world', ['Hellas', 'Ελλάδα']],
];

const KZ_PROVINCES: Row[] = [
  ['KZ-KUS', 'Kostanay Region', 'Костанайская область', [59.5, 48.9, 66.9, 54.0], 'central-asia', ['Qostanai', 'Kostanai'], true],
  ['KZ-SEV', 'North Kazakhstan Region', 'Северо-Казахстанская область', [65.4, 52.6, 72.1, 55.4], 'central-asia', ['Soltüstik Qazaqstan', 'Petropavl']],
  ['KZ-AKM', 'Akmola Region', 'Акмолинская область', [65.4, 50.3, 73.4, 53.8], 'central-asia', ['Aqmola', 'Kokshetau']],
  ['KZ-PAV', 'Pavlodar Region', 'Павлодарская область', [72.8, 50.3, 79.2, 54.1], 'central-asia', ['Pavlodar']],
  ['KZ-VOS', 'East Kazakhstan Region', 'Восточно-Казахстанская область', [79.0, 47.0, 87.3, 51.7], 'central-asia', ['Shygys Qazaqstan', 'Oskemen', 'Ust-Kamenogorsk'], true],
  ['KZ-ALM', 'Almaty Region', 'Алматинская область', [73.8, 42.3, 80.3, 46.6], 'central-asia', ['Almaty oblysy', 'Balkhash', 'Ili'], true],
  ['KZ-KZY', 'Kyzylorda Region', 'Кызылординская область', [58.5, 42.6, 68.4, 47.3], 'central-asia', ['Qyzylorda', 'Syr Darya']],
  ['KZ-ZAP', 'West Kazakhstan Region', 'Западно-Казахстанская область', [46.6, 48.0, 54.8, 51.8], 'central-asia', ['Batys Qazaqstan', 'Oral', 'Uralsk']],
  ['KZ-AKT', 'Aktobe Region', 'Актюбинская область', [53.2, 45.4, 63.3, 51.2], 'central-asia', ['Aqtöbe', 'Aktobe']],
  ['KZ-KAR', 'Karaganda Region', 'Карагандинская область', [64.7, 45.0, 76.0, 51.5], 'central-asia', ['Qaraghandy', 'Karagandy']],
];

export function buildRegions(): Region[] {
  const countries: Region[] = COUNTRIES.map(([id, en, ru, bbox, group, aliases, featured]) => ({
    id,
    kind: 'country',
    iso2: id,
    name: { en, ru },
    bbox,
    group,
    ...(aliases ? { aliases } : {}),
    ...(featured ? { featured } : {}),
  }));
  const provinces: Region[] = KZ_PROVINCES.map(([id, en, ru, bbox, group, aliases, featured]) => ({
    id,
    kind: 'province',
    parentId: 'KZ',
    name: { en, ru },
    bbox,
    group,
    ...(aliases ? { aliases } : {}),
    ...(featured ? { featured } : {}),
  }));
  return [...countries, ...provinces];
}
