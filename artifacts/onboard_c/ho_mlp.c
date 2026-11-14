#include "ho_mlp.h"

/* Rounding right shift, half away from zero, using shifts of non-negative values only (portable). */
int32_t ho_rshift_round(int64_t v, int s)
{
    const int64_t half = (int64_t)1 << (s - 1);
    if (v >= 0) {
        return (int32_t)((v + half) >> s);
    }
    return (int32_t)(-(((-v) + half) >> s));
}

int ho_mlp_run(const ho_layer_t *layers, uint8_t n_layers, const uint16_t *lut, const int8_t *x, uint16_t *out_q15)
{
    int8_t buf[2][HO_MAX_WIDTH];
    const int8_t *in = x;
    uint8_t cur = 0u;
    uint8_t l;
    for (l = 0u; l < n_layers; ++l) {
        const ho_layer_t *L = &layers[l];
        uint16_t j;
        if (L->n_in > HO_MAX_WIDTH || L->n_out > HO_MAX_WIDTH) {
            return -1;
        }
        for (j = 0u; j < L->n_out; ++j) {
            const int8_t *w = &L->w[(uint32_t)j * L->n_in];
            int32_t acc = L->b[j];
            int32_t y;
            uint16_t i;
            for (i = 0u; i < L->n_in; ++i) {
                acc += (int32_t)w[i] * (int32_t)in[i];
            }
            y = ho_rshift_round((int64_t)acc * (int64_t)L->m[j], HO_Q);
            if (L->act == HO_ACT_RELU) {
                if (y < 0) {
                    y = 0;
                }
                if (y > 127) {
                    y = 127;
                }
                buf[cur][j] = (int8_t)y;
            } else {
                int32_t t = y - HO_LUT_LO;
                int32_t idx;
                int32_t frac;
                int32_t lo;
                int32_t hi;
                if (t < 0) {
                    t = 0;
                }
                if (t > ((HO_LUT_N - 1) << HO_LUT_SHIFT)) {
                    t = (HO_LUT_N - 1) << HO_LUT_SHIFT;
                }
                idx = t >> HO_LUT_SHIFT;
                if (idx > HO_LUT_N - 2) {
                    idx = HO_LUT_N - 2;
                }
                frac = t - (idx << HO_LUT_SHIFT);
                lo = (int32_t)lut[idx];
                hi = (int32_t)lut[idx + 1];
                out_q15[j] = (uint16_t)(lo + (((hi - lo) * frac + (1 << (HO_LUT_SHIFT - 1))) >> HO_LUT_SHIFT));
            }
        }
        if (L->act == HO_ACT_RELU) {
            in = buf[cur];
            cur ^= 1u;
        }
    }
    return 0;
}
