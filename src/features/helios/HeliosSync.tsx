import { useEffect } from 'react';
import { useMapStore } from '@/features/map/mapStore';
import {
  useHeliosAlerts,
  useHeliosAvailable,
  useHeliosBlind,
  useHeliosRisk,
  useHeliosSatellites,
  useHeliosSpread,
  useHeliosStatic,
} from './api';
import {
  addHeliosLayers,
  setAlerts,
  setBlind,
  setHeliosVisible,
  setRisk,
  setSatellites,
  setSpread,
  setStatic,
} from './heliosLayers';
import { HELIOS_LAYERS, useHeliosStore } from './heliosStore';

/**
 * Pushes the HELIOS layers into the map (like MapSync does for detections). Data are fetched only for
 * layers that are switched on; renders nothing. Inactive when the app runs on the synthetic demo.
 */
export function HeliosSync() {
  const available = useHeliosAvailable();
  const map = useMapStore((s) => s.map);
  const status = useMapStore((s) => s.status);
  const mapMode = useMapStore((s) => s.mapMode);
  const layers = useHeliosStore((s) => s.layers);
  const horizon = useHeliosStore((s) => s.horizon);
  const scenario = useHeliosStore((s) => s.scenario);
  const ready = available && map !== null && status === 'ready';

  const risk = useHeliosRisk(horizon, scenario, ready && layers.risk);
  const alerts = useHeliosAlerts(ready && layers.alerts);
  const statics = useHeliosStatic(ready && layers.static);
  const blind = useHeliosBlind(ready && layers.blind);
  const spread = useHeliosSpread(ready && layers.spread);
  const sats = useHeliosSatellites(ready && layers.satellites);

  useEffect(() => {
    if (ready && map) addHeliosLayers(map);
  }, [ready, map]);

  useEffect(() => {
    if (!ready || !map) return;
    for (const layer of HELIOS_LAYERS) setHeliosVisible(map, layer, mapMode && layers[layer]);
  }, [ready, map, mapMode, layers]);

  useEffect(() => {
    if (ready && map && risk.data) setRisk(map, risk.data.rows);
  }, [ready, map, risk.data]);
  useEffect(() => {
    if (ready && map && alerts.data) setAlerts(map, alerts.data.rows);
  }, [ready, map, alerts.data]);
  useEffect(() => {
    if (ready && map && statics.data) setStatic(map, statics.data.rows);
  }, [ready, map, statics.data]);
  useEffect(() => {
    if (ready && map && blind.data) setBlind(map, blind.data.rows);
  }, [ready, map, blind.data]);
  useEffect(() => {
    if (ready && map && spread.data) setSpread(map, spread.data);
  }, [ready, map, spread.data]);
  useEffect(() => {
    if (ready && map && sats.data) setSatellites(map, sats.data);
  }, [ready, map, sats.data]);

  return null;
}
