/* Host self-test: C == Python reference bit for bit; error vs the float model; packet bytes. */
#include <stdio.h>
#include <stdlib.h>
#include "helios_onboard.h"
#include "ho_test_vectors.h"

int main(void)
{
    int i, j, exact_bad = 0, prio_same = 0, a2_same = 0;
    long max_err1 = 0, max_err2 = 0;
    double sum_err1 = 0.0, sum_err2 = 0.0;
    uint8_t pkt[HO_PACKET_BYTES];
    ho_alert_t a;
    for (i = 0; i < HO_N_TEST; ++i) {
        uint16_t p[HO_AI1_N_OUT];
        uint16_t q[HO_AI2_N_OUT];
        if (ho_ai1_infer(t_ai1_x[i], p) != 0 || ho_ai2_infer(t_ai2_x[i], q) != 0) {
            printf("inference error\n");
            return 2;
        }
        for (j = 0; j < HO_AI1_N_OUT; ++j) {
            long e = labs((long)p[j] - (long)t_ai1_float[i][j]);
            if (p[j] != t_ai1_exact[i][j]) exact_bad++;
            if (e > max_err1) max_err1 = e;
            sum_err1 += (double)e;
        }
        if (ho_ai1_priority(p) == t_ai1_prio[i]) prio_same++;
        {
            long e = labs((long)q[0] - (long)t_ai2_float[i][0]);
            if (q[0] != t_ai2_exact[i][0]) exact_bad++;
            if (e > max_err2) max_err2 = e;
            sum_err2 += (double)e;
            if ((q[0] >= 16384) == (t_ai2_float[i][0] >= 16384)) a2_same++;
        }
    }
    a = t_packet_alert;
    ho_packet_encode(&a, pkt);
    for (j = 0; j < HO_PACKET_BYTES; ++j) {
        if (pkt[j] != t_packet_bytes[j]) {
            printf("packet mismatch at byte %d\n", j);
            return 3;
        }
    }
    printf("{\"vectors\": %d, \"bit_exact_mismatches\": %d, "
           "\"ai1_max_abs_err\": %.4f, \"ai1_mean_abs_err\": %.5f, \"ai1_priority_agreement\": %.4f, "
           "\"ai2_max_abs_err\": %.4f, \"ai2_mean_abs_err\": %.5f, \"ai2_decision_agreement\": %.4f, \"packet_ok\": true}\n",
           HO_N_TEST, exact_bad, max_err1 / 32767.0, sum_err1 / (HO_N_TEST * HO_AI1_N_OUT * 32767.0),
           (double)prio_same / HO_N_TEST, max_err2 / 32767.0, sum_err2 / (HO_N_TEST * 32767.0), (double)a2_same / HO_N_TEST);
    return exact_bad == 0 ? 0 : 1;
}
