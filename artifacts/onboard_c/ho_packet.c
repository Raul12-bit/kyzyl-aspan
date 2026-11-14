#include "helios_onboard.h"

uint16_t ho_crc16_ccitt(const uint8_t *data, uint32_t n)
{
    uint16_t crc = 0xFFFFu;
    uint32_t i;
    for (i = 0u; i < n; ++i) {
        uint8_t b;
        crc ^= (uint16_t)((uint16_t)data[i] << 8);
        for (b = 0u; b < 8u; ++b) {
            crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }

void ho_packet_encode(const ho_alert_t *a, uint8_t out[HO_PACKET_BYTES])
{
    uint16_t crc;
    out[0] = 1u; /* format version */
    out[1] = a->priority;
    out[2] = a->sat_id;
    out[3] = a->flags;
    put32(&out[4], a->unix_time);
    put32(&out[8], (uint32_t)a->lat_e5);
    put32(&out[12], (uint32_t)a->lon_e5);
    put16(&out[16], a->frp_x10);
    put16(&out[18], a->cluster_n);
    out[20] = a->p_esc_u8;
    out[21] = a->p_real_u8;
    crc = ho_crc16_ccitt(out, 22u);
    put16(&out[22], crc);
}
