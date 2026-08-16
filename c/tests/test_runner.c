/* Optiline — shared test harness implementation (§24). */
#include <stdio.h>
#include <string.h>
#include "test_runner.h"

#define OP_TEST_MAX 4096

typedef struct {
    const char *suite;
    const char *name;
    op_test_fn  fn;
} op_test_case;

static op_test_case g_tests[OP_TEST_MAX];
static int g_test_count = 0;
static int g_current_failed = 0;
static int g_total_failed = 0;

void op_test_add(const char *suite, const char *name, op_test_fn fn) {
    if (g_test_count < OP_TEST_MAX) {
        g_tests[g_test_count].suite = suite;
        g_tests[g_test_count].name = name;
        g_tests[g_test_count].fn = fn;
        g_test_count++;
    } else {
        fprintf(stderr, "FATAL: test capacity exceeded\n");
    }
}

void op_test_fail_at(const char *file, int line, const char *expr,
                     double got, double want, double tol, int has_values) {
    g_current_failed = 1;
    if (has_values) {
        fprintf(stderr, "  FAIL %s:%d: %s (got %.17g, want %.17g, tol %.3g)\n",
                file, line, expr, got, want, tol);
    } else {
        fprintf(stderr, "  FAIL %s:%d: %s\n", file, line, expr);
    }
}

const char *op_test_fixture_dir(void) {
#ifdef OPTILINE_FIXTURE_DIR
    return OPTILINE_FIXTURE_DIR;
#else
    return "fixtures";
#endif
}

int main(int argc, char **argv) {
    const char *filter = (argc > 1) ? argv[1] : NULL;
    int ran = 0;

#ifdef OPTILINE_PLAYBACK_TESTS
    op_register_playback();
#else
    op_register_math();
    op_register_interval();
    op_register_span();
    op_register_gram();
    op_register_regularity();
    op_register_offset();
    op_register_selfint();
    op_register_containment();
    op_register_dynamics();
    op_register_construction();
    op_register_optimizer();
    op_register_track();
    op_register_abi();
    op_register_canonical();
    op_register_oracle();
#endif

    for (int i = 0; i < g_test_count; i++) {
        if (filter && !strstr(g_tests[i].suite, filter) &&
            !strstr(g_tests[i].name, filter)) {
            continue;
        }
        g_current_failed = 0;
        printf("[%s] %s\n", g_tests[i].suite, g_tests[i].name);
        fflush(stdout);
        g_tests[i].fn();
        ran++;
        if (g_current_failed) {
            g_total_failed++;
            printf("  -> FAILED\n");
        }
    }

    printf("\n%d tests ran, %d failed\n", ran, g_total_failed);
    return g_total_failed == 0 ? 0 : 1;
}
