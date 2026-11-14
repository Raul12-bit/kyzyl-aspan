/* Integer MLP engine shared by the HELIOS onboard models (see helios_onboard.h). */
#ifndef HO_MLP_H
#define HO_MLP_H

#include <stdint.h>

#define HO_Q 24          /* requantization multipliers are Q24 */
#define HO_LUT_LO (-2048) /* sigmoid table covers logits -8 … +8 in Q8 */
#define HO_LUT_SHIFT 4    /* table step 1/16 */
#define HO_LUT_N 257
#define HO_MAX_WIDTH 64

enum { HO_ACT_RELU = 0, HO_ACT_SIGMOID = 1 };

typedef struct {
    uint16_t n_in;
    uint16_t n_out;
    uint8_t act;
    const int8_t *w;   /* [n_out][n_in] */
    const int32_t *b;  /* [n_out], scale s_in * s_w */
    const int32_t *m;  /* [n_out], Q24 multiplier to the next scale */
} ho_layer_t;

int ho_mlp_run(const ho_layer_t *layers, uint8_t n_layers, const uint16_t *lut, const int8_t *x, uint16_t *out_q15);
int32_t ho_rshift_round(int64_t v, int s);

#endif /* HO_MLP_H */
