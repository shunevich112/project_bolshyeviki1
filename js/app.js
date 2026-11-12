/* Почвенная карта территории (Большевик) — интерактивное веб-приложение */
(function () {
    'use strict';

    var CFG = window.MAP_CONFIG || {};
    var map, basemapLayer = null;
    var soilsLayer = null, namesLayer = null, boundaryLayer = null;
    var reliefLayer = null;
    var soilColor = {};           // значение -> цвет
    var activeSoil = null;        // выбранная почва (фильтр)
    var soilsOpacity = 1;         // текущая прозрачность слоя почв

    /* ---------------- Тема ---------------- */
    var themeBtn = document.getElementById('btn-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var themeParam = (location.search.match(/[?&]theme=(light|dark)/) || [])[1];
    var theme = themeParam || localStorage.getItem('soilmap-theme') || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    themeBtn.addEventListener('click', function () {
        theme = theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('soilmap-theme', theme);
    });

    /* ---------------- Загрузка данных ---------------- */
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Не загружен ' + src)); };
            document.head.appendChild(s);
        });
    }

    function loadAll(files) {
        return files.reduce(function (p, f) {
            return p.then(function () { return loadScript(f); });
        }, Promise.resolve());
    }

    /* ---------------- Утилиты ---------------- */
    function hexToRgba(hex, alpha) {
        var h = (hex || '#888888').replace('#', '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var r = parseInt(h.substring(0, 2), 16),
            g = parseInt(h.substring(2, 4), 16),
            b = parseInt(h.substring(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function fmtArea(v) {
        if (v === null || v === undefined || isNaN(v)) return '';
        return (Math.round(v * 100) / 100).toLocaleString('ru-RU') + ' га';
    }

    function toUTM(lat, lon) {
        var a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
        var e2 = 2 * f - f * f, ep2 = e2 / (1 - e2);
        var zone = Math.floor((lon + 180) / 6) + 1;
        var lon0 = (zone - 1) * 6 - 180 + 3;
        var phi = lat * Math.PI / 180, lam = (lon - lon0) * Math.PI / 180;
        var N = a / Math.sqrt(1 - e2 * Math.sin(phi) * Math.sin(phi));
        var T = Math.tan(phi) * Math.tan(phi);
        var C = ep2 * Math.cos(phi) * Math.cos(phi);
        var A = Math.cos(phi) * lam;
        var M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi
            - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi)
            + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi)
            - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi));
        var easting = k0 * N * (A + (1 - T + C) * Math.pow(A, 3) / 6
            + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120) + 500000;
        var northing = k0 * (M + N * Math.tan(phi) * (A * A / 2
            + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
            + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720));
        return [easting, northing];
    }

    /* ---------------- Стили слоёв ---------------- */
    function soilStyle(feature) {
        var val = feature.properties.soil_clean || '';
        var dim = activeSoil !== null && val !== activeSoil;
        return {
            color: dim ? 'rgba(120,120,120,0.35)' : 'rgba(70,70,70,0.85)',
            weight: dim ? 0.4 : 0.7,
            fillColor: soilColor[val] || '#c9b79c',
            fillOpacity: (dim ? 0.05 : 0.62) * soilsOpacity,
            opacity: (dim ? 0.3 : 1) * soilsOpacity
        };
    }

    function popupHtml(title, rows) {
        var html = '<div class="popup-title">' + title + '</div>';
        rows.forEach(function (r) {
            if (r[1] === null || r[1] === undefined || r[1] === '') return;
            html += '<div class="popup-row"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
        });
        return html;
    }

    /* ---------------- Инициализация карты ---------------- */
    function init() {
        var ext = CFG.extent; // [[south, west], [north, east]]
        var bounds = L.latLngBounds(ext[0], ext[1]);

        map = L.map('map', {
            zoomControl: false,
            minZoom: CFG.minZoom || 10,
            maxZoom: CFG.maxZoom || 19,
            zoomSnap: 0.25,
            attributionControl: true
        }).fitBounds(bounds, { padding: [10, 10] });

        window.__soilMap = map;

        /* растры — в отдельную панель ниже векторной (overlayPane, 400),
           иначе L.imageOverlay с z-index:1 перекрывает контуры */
        map.createPane('rasterPane');
        map.getPane('rasterPane').style.zIndex = 350;

        L.control.zoom({ position: 'topleft' }).addTo(map);

        /* --- подложки --- */
        var basemaps = {
            'ESRI Gray': L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                { maxZoom: 16, attribution: 'Tiles &copy; Esri' }),
            'OpenStreetMap': L.tileLayer(
                'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
            'ESRI Imagery': L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                { maxZoom: 18, attribution: 'Tiles &copy; Esri' })
        };
        basemapLayer = basemaps[CFG.basemap || 'ESRI Gray'];
        basemapLayer.addTo(map);

        var bmSelect = document.getElementById('basemapSelect');
        Object.keys(basemaps).forEach(function (name) {
            var o = document.createElement('option');
            o.value = name;
            o.textContent = name;
            bmSelect.appendChild(o);
        });
        bmSelect.value = CFG.basemap || 'ESRI Gray';
        bmSelect.addEventListener('change', function () {
            map.removeLayer(basemapLayer);
            basemapLayer = basemaps[this.value];
            basemapLayer.addTo(map);
            basemapLayer.bringToBack();
        });

        /* --- растры --- */
        if (CFG.rasters) {
            if (CFG.rasters.relief) {
                reliefLayer = L.imageOverlay(CFG.rasters.relief.file,
                    L.latLngBounds(CFG.rasters.relief.bounds[0], CFG.rasters.relief.bounds[1]),
                    { pane: 'rasterPane', opacity: 0.4, interactive: false }).addTo(map);
            }
        }

        /* --- почвенные контуры --- */
        soilsLayer = L.geoJSON(window[CFG.layers.soils.varName], {
            style: soilStyle,
            onEachFeature: function (f, layer) {
                var p = f.properties;
                layer.bindPopup(popupHtml(p.soil_clean || 'Почва', [
                    ['Почвенный индекс', p.soil],
                    ['Площадь', fmtArea(p.area)]
                ]), { maxWidth: 300 });
                layer.on('mouseover', function () { this.setStyle({ weight: 2, color: '#26473a' }); });
                layer.on('mouseout', function () { soilsLayer.resetStyle(this); });
            }
        }).addTo(map);

        /* --- граница территории --- */
        boundaryLayer = L.geoJSON(window[CFG.layers.boundary.varName], {
            style: { color: '#c00000', weight: 2.4, dashArray: '7 5', fill: false },
            onEachFeature: function (f, layer) {
                var p = f.properties;
                layer.bindPopup(popupHtml(p.name || 'Общая территория', [
                    ['Площадь', fmtArea(p.area_ha)]
                ]), { maxWidth: 300 });
            }
        }).addTo(map);

        /* --- названия почв --- */
        namesLayer = L.geoJSON(window[CFG.layers.names.varName], {
            pointToLayer: function (f, latlng) {
                return L.circleMarker(latlng, {
                    radius: 2, weight: 1,
                    color: 'rgba(80,60,40,.8)', fillColor: '#fff', fillOpacity: 1
                });
            },
            onEachFeature: function (f, layer) {
                var p = f.properties;
                layer.bindTooltip(p.soil_clean || '', {
                    permanent: true, direction: 'center', offset: [0, -2],
                    className: 'soil-tooltip', opacity: 1
                });
                layer.bindPopup(popupHtml(p.soil_clean || 'Почва', [
                    ['Почвенный индекс', p.soil],
                    ['Площадь', fmtArea(p.area_ha)]
                ]), { maxWidth: 300 });
            }
        }).addTo(map);

        function updateLabels() {
            var show = map.getZoom() >= (CFG.labelMinZoom || 12);
            if (!namesLayer) return;
            namesLayer.eachLayer(function (l) {
                if (show) { if (!l.getTooltip()) return; l.openTooltip(); }
                else { l.closeTooltip(); }
            });
        }
        map.on('zoomend', updateLabels);
        updateLabels();

        buildLayerList();
        buildSoilList();
        initCoords();
        initScale();
        initHeaderButtons(bounds);

        /* Leaflet кэширует смещение контейнера: если шапка/размер окна
           меняются после инициализации, векторный слой уезжает. */
        function refreshSize() {
            map.invalidateSize(false);
        }
        window.addEventListener('resize', refreshSize);
        window.addEventListener('orientationchange', refreshSize);
        setTimeout(refreshSize, 50);
        setTimeout(refreshSize, 400);
        if (window.ResizeObserver) {
            new ResizeObserver(refreshSize).observe(document.getElementById('map'));
        }
    }

    /* ---------------- Список слоёв ---------------- */
    function overlayList() {
        return [
            { key: 'soils', label: 'Почвенные контуры', layer: soilsLayer },
            { key: 'names', label: 'Названия почв', layer: namesLayer },
            { key: 'boundary', label: 'Граница территории', layer: boundaryLayer },
            { key: 'relief', label: 'Рельеф (тень)', layer: reliefLayer }
        ];
    }

    /* ---------------- Прозрачность ---------------- */
    var opacityStore = { soils: 1, names: 1, boundary: 1, relief: 0.4 };
    var opacityRowSync = {};       // key -> обновление ползунка в списке слоёв

    function getLayerOpacity(key) {
        return opacityStore[key] !== undefined ? opacityStore[key] : 1;
    }

    function applyLayerOpacity(key, value) {
        opacityStore[key] = value;
        if (key === 'soils') {
            soilsOpacity = value;
            if (soilsLayer) soilsLayer.setStyle(soilStyle);
        } else if (key === 'relief') {
            if (reliefLayer && reliefLayer.setOpacity) reliefLayer.setOpacity(value);
        } else if (key === 'names') {
            if (namesLayer) namesLayer.setStyle({ opacity: value, fillOpacity: value });
        } else if (key === 'boundary') {
            if (boundaryLayer) boundaryLayer.setStyle({ opacity: value });
        }
        if (opacityRowSync[key]) opacityRowSync[key]();
    }

    function buildLayerList() {
        var box = document.getElementById('layerList');
        box.innerHTML = '';
        opacityRowSync = {};

        overlayList().forEach(function (item) {
            if (!item.layer) return;

            var row = document.createElement('div');
            row.className = 'layer-item';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = map.hasLayer(item.layer);

            var span = document.createElement('span');
            span.className = 'layer-name';
            span.textContent = item.label;
            span.title = item.label;

            var wrap = document.createElement('div');
            wrap.className = 'layer-opacity';

            var slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.step = '5';
            slider.value = String(Math.round(getLayerOpacity(item.key) * 100));
            slider.title = 'Прозрачность: ' + slider.value + '%';
            slider.setAttribute('aria-label', 'Прозрачность слоя «' + item.label + '»');

            var out = document.createElement('span');
            out.className = 'layer-opacity-value';
            out.textContent = slider.value + '%';

            function toggleLayer() {
                if (cb.checked) item.layer.addTo(map);
                else map.removeLayer(item.layer);
                row.classList.toggle('layer-off', !cb.checked);
            }

            cb.addEventListener('change', toggleLayer);
            span.addEventListener('click', function () {
                cb.checked = !cb.checked;
                toggleLayer();
            });

            slider.addEventListener('input', function () {
                var v = parseInt(slider.value, 10);
                applyLayerOpacity(item.key, v / 100);
            });

            opacityRowSync[item.key] = function () {
                var v = Math.round(getLayerOpacity(item.key) * 100);
                slider.value = String(v);
                slider.title = 'Прозрачность: ' + v + '%';
                out.textContent = v + '%';
            };

            wrap.appendChild(slider);
            wrap.appendChild(out);
            row.appendChild(cb);
            row.appendChild(span);
            row.appendChild(wrap);
            row.classList.toggle('layer-off', !cb.checked);
            box.appendChild(row);
        });
    }

    /* ---------------- Список почв ---------------- */
    function buildSoilList() {
        var list = document.getElementById('soilList');
        var countEl = document.getElementById('soilCount');
        var cats = CFG.categories || [];
        countEl.textContent = String(cats.length);
        list.innerHTML = '';

        cats.forEach(function (c) {
            soilColor[c.name] = c.color;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'soil-item';
            btn.dataset.name = c.name;

            var sw = document.createElement('span');
            sw.className = 'swatch';
            sw.style.background = c.color;

            var nm = document.createElement('span');
            nm.className = 'soil-name';
            nm.textContent = c.name;
            nm.title = c.name + (c.count ? ' — ' + c.count + ' конт.' : '');

            var ar = document.createElement('span');
            ar.className = 'soil-area';
            ar.textContent = fmtArea(c.area);

            btn.appendChild(sw); btn.appendChild(nm); btn.appendChild(ar);
            btn.addEventListener('click', function () { selectSoil(c.name); });
            list.appendChild(btn);
        });

        /* применяем цвета к уже созданному слою */
        if (soilsLayer) soilsLayer.setStyle(soilStyle);

        var search = document.getElementById('soilSearch');
        search.addEventListener('input', function () {
            var q = this.value.trim().toLowerCase();
            Array.prototype.forEach.call(list.children, function (el) {
                var name = (el.dataset.name || '').toLowerCase();
                el.style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
            });
        });
    }

    function selectSoil(name) {
        activeSoil = (activeSoil === name) ? null : name;
        soilsLayer.setStyle(soilStyle);

        Array.prototype.forEach.call(document.querySelectorAll('.soil-item'), function (el) {
            el.classList.toggle('active', el.dataset.name === activeSoil);
        });

        if (activeSoil) {
            var group = L.featureGroup();
            soilsLayer.eachLayer(function (l) {
                if ((l.feature.properties.soil_clean || '') === activeSoil) group.addLayer(l);
            });
            if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 16 });
        } else {
            map.fitBounds(L.latLngBounds(CFG.extent[0], CFG.extent[1]), { padding: [10, 10] });
        }
    }

    /* ---------------- Координаты, масштаб, кнопки ---------------- */
    function initCoords() {
        var el = document.getElementById('coords');
        map.on('mousemove', function (e) {
            var lat = e.latlng.lat, lon = e.latlng.lng;
            var utm = toUTM(lat, lon);
            el.textContent = lat.toFixed(5) + '°, ' + lon.toFixed(5) + '°  ·  X ' +
                Math.round(utm[0]) + ' Y ' + Math.round(utm[1]) + ' (EPSG:32640)';
        });
        map.on('mouseout', function () { el.textContent = '—'; });
    }

    function initScale() {
        var bar = document.getElementById('scaleBar');
        var txt = document.getElementById('scaleText');
        function update() {
            var y = map.getSize().y / 2;
            var p1 = map.containerPointToLatLng([0, y]);
            var p2 = map.containerPointToLatLng([120, y]);
            var m = p1.distanceTo(p2);
            var nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
            var target = m, best = nice[0];
            for (var i = 0; i < nice.length; i++) {
                if (nice[i] <= target) best = nice[i];
                else break;
            }
            bar.style.width = Math.max(40, Math.round(120 * best / target)) + 'px';
            txt.textContent = best >= 1000
                ? (best / 1000).toLocaleString('ru-RU') + ' км'
                : best.toLocaleString('ru-RU') + ' м';
        }
        map.on('zoomend moveend', update);
        update();
    }

    function initHeaderButtons(bounds) {
        document.getElementById('btn-home').addEventListener('click', function () {
            activeSoil = null;
            Array.prototype.forEach.call(document.querySelectorAll('.soil-item'), function (el) {
                el.classList.remove('active');
            });
            soilsLayer.setStyle(soilStyle);
            map.fitBounds(bounds, { padding: [10, 10] });
        });

        var fsBtn = document.getElementById('btn-fullscreen');
        fsBtn.addEventListener('click', function () {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
            } else if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', function () {
            document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
            setTimeout(function () { map.invalidateSize(); }, 150);
        });

        /* сворачивание панелей */
        Array.prototype.forEach.call(document.querySelectorAll('.panel-header'), function (h) {
            h.addEventListener('click', function (e) {
                if (e.target.closest('.panel-toggle')) {
                    e.stopPropagation();
                }
                h.parentElement.classList.toggle('collapsed');
            });
        });

        /* показать все контуры */
        document.getElementById('btn-show-all').addEventListener('click', function () {
            activeSoil = null;
            Array.prototype.forEach.call(document.querySelectorAll('.soil-item'), function (el) {
                el.classList.remove('active');
            });
            soilsLayer.setStyle(soilStyle);
        });

        /* оставить только подложку и область */
        document.getElementById('btn-reset-layers').addEventListener('click', function () {
            activeSoil = null;
            Array.prototype.forEach.call(document.querySelectorAll('.soil-item'), function (el) {
                el.classList.remove('active');
            });
            soilsLayer.setStyle(soilStyle);
            overlayList().forEach(function (item) {
                if (!item.layer) return;
                if (item.key === 'boundary') { if (!map.hasLayer(item.layer)) item.layer.addTo(map); }
                else if (map.hasLayer(item.layer)) map.removeLayer(item.layer);
            });
            buildLayerList();
        });
    }

    /* ---------------- Старт ---------------- */
    var files = [];
    if (CFG.layers) {
        if (CFG.layers.soils) files.push(CFG.layers.soils.file);
        if (CFG.layers.names) files.push(CFG.layers.names.file);
        if (CFG.layers.boundary) files.push(CFG.layers.boundary.file);
    }
    loadAll(files).then(function () {
        document.getElementById('app-title').textContent = CFG.title || 'Почвенная карта';
        document.getElementById('app-subtitle').textContent = CFG.subtitle || '';
        document.getElementById('footer-title').textContent = CFG.footer || CFG.title || '';
        document.title = CFG.title || 'Почвенная карта';
        init();
    }).catch(function (err) {
        console.error(err);
        var d = document.createElement('div');
        d.style.cssText = 'position:absolute;top:100px;left:20px;padding:12px 16px;background:#fff;color:#a00;border-radius:8px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.2)';
        d.textContent = 'Не удалось загрузить данные карты: ' + err.message;
        document.body.appendChild(d);
    });
})();
