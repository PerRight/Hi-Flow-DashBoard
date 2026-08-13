/**
 * basemap.js — MapLibre 래스터 베이스맵 스타일.
 *
 * CLAUDE.md 3절은 VWorld 위성 타일을 기준으로 한다.
 * VWORLD_KEY(config.js)가 비어 있으면 OSM 래스터로 폴백한다.
 * 키를 발급받으면 config.js 의 VWORLD_KEY 한 곳만 채우면 위성으로 전환된다.
 */

import { VWORLD_KEY } from './config.js';

export const usingVWorld = () => Boolean(VWORLD_KEY);

export function basemapLabel() {
  return usingVWorld() ? 'VWorld 위성' : 'OSM (VWorld 키 미설정)';
}

export function makeBasemapStyle() {
  if (usingVWorld()) {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Satellite/{z}/{y}/{x}.jpeg`],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© VWorld'
        },
        hybrid: {
          type: 'raster',
          tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Hybrid/{z}/{y}/{x}.png`],
          tileSize: 256,
          maxzoom: 19
        }
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base' },
        { id: 'hybrid', type: 'raster', source: 'hybrid' }
      ]
    };
  }

  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0e1418' } },
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.85 } }
    ]
  };
}
