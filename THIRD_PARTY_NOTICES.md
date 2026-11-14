# Третьи стороны: код, идеи и данные

## Код, адаптированный по лицензии MIT

### flare-chronos — https://github.com/the-aris-club/flare-chronos
Адаптировано (переписано на векторный numpy и изменено) в `helios/processing/solar.py`,
`helios/processing/footprint.py`, `helios/processing/filters.py`, `helios/processing/persistence.py`:
формулы зенитного угла Солнца и день/ночь по SZA < 85°, геометрия пикселя MODIS/VIIRS по углу скана,
отображение уверенности MODIS/VIIRS в единую P(fire), фильтр Южно-Атлантической аномалии,
критерий «≥10 месяцев в году» для постоянных источников.

```
MIT License

Copyright (c) 2026 Xiro The Dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MODIS-VIIRS-fires — https://github.com/meredithfranklin/MODIS-VIIRS-fires
Идея годовой HDBSCAN-кластеризации для поиска постоянных источников горения (факелы, свалки)
перенесена с R на Python (`sklearn.cluster.HDBSCAN`) и усилена проверкой повторяемости между годами
(`helios/processing/persistence.py`).
Franklin, M., et al. (2025). *Journal of Exposure Science & Environmental Epidemiology*. doi:10.1038/s41370-025-00804-z

```
MIT License

Copyright (c) 2025 Meredith Franklin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Только идеи (код не копировался)

### Kiln-Watch — https://github.com/Aalvee-Aarham/kiln-watch
В репозитории нет лицензии, поэтому код **не** использовался. Реализованы своими словами идеи:
шкала Aqua MODIS как общая; калибровка «отношение сумм по месяцам» со сжатием эмпирическим Байесом;
маска статичных ячеек по полю `type`; тест «MODIS выключили»; принцип ИИ-аналитика
«модель пишет слова — числа из пайплайна».

## Данные и API

| Источник | Что берём | Условия |
|---|---|---|
| NASA FIRMS (LANCE, MODIS C6.1 / VIIRS C2) | активные пожары: годовой архив, NRT, Area API | открытые данные NASA; просьба указывать FIRMS |
| NASA POWER (LaRC) | суточная погода и облачность | открытые данные NASA |
| NASA Earthdata CMR | метаданные гранул (задержки) | открыто |
| NASA EONET, GIBS, DONKI | события, тайлы снимков, вспышки | открыто |
| CelesTrak | орбитальные элементы TLE | свободное использование |
| NOAA SWPC | Kp, рентген GOES, вспышки | public domain |
| GFZ Potsdam | Kp, F10.7 | CC BY 4.0 |
| Open-Meteo (ERA5/прогноз) | почасовая погода у станций | CC BY 4.0 |
| geoBoundaries (OSM) | контур страны | ODbL 1.0 |

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System
> (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System (ESDIS).
> NASA POWER data were obtained from the NASA Langley Research Center POWER Project funded through the NASA Earth Science Directorate Applied Science Program.
