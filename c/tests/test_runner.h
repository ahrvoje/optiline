/* Optiline — minimal shared C test harness (§24).
 * MSVC /TC /std:c17 and WASI Clang -std=c99 compatible; no constructors,
 * explicit registration from test_runner.c.
 */
#ifndef OPTILINE_TEST_RUNNER_H
#define OPTILINE_TEST_RUNNER_H

#include <stddef.h>

typedef void (*op_test_fn)(void);

/* Register a test case; called from each suite's op_register_* function. */
void op_test_add(const char *suite, const char *name, op_test_fn fn);

/* Assertion helpers. Failures record a message and mark the current test
 * failed; execution of the current test continues (soft assert) unless
 * OP_REQUIRE is used, which returns from the calling function.          */
void op_test_fail_at(const char *file, int line, const char *expr,
                     double got, double want, double tol, int has_values);

#define OP_ASSERT(cond) \
    do { if (!(cond)) op_test_fail_at(__FILE__, __LINE__, #cond, 0, 0, 0, 0); } while (0)

#define OP_REQUIRE(cond) \
    do { if (!(cond)) { op_test_fail_at(__FILE__, __LINE__, #cond, 0, 0, 0, 0); return; } } while (0)

#define OP_ASSERT_NEAR(got, want, tol) \
    do { \
        double op_g_ = (double)(got), op_w_ = (double)(want), op_t_ = (double)(tol); \
        double op_d_ = op_g_ > op_w_ ? op_g_ - op_w_ : op_w_ - op_g_; \
        if (!(op_d_ <= op_t_)) \
            op_test_fail_at(__FILE__, __LINE__, #got " ~= " #want, op_g_, op_w_, op_t_, 1); \
    } while (0)

#define OP_ASSERT_EQ_INT(got, want) \
    do { \
        long long op_g_ = (long long)(got), op_w_ = (long long)(want); \
        if (op_g_ != op_w_) \
            op_test_fail_at(__FILE__, __LINE__, #got " == " #want, \
                            (double)op_g_, (double)op_w_, 0, 1); \
    } while (0)

/* Suite registration functions; each test_*.c file defines exactly one.
 * test_runner.c calls the set that belongs to the current binary.       */
void op_register_math(void);
void op_register_interval(void);
void op_register_span(void);
void op_register_gram(void);
void op_register_regularity(void);
void op_register_offset(void);
void op_register_selfint(void);
void op_register_containment(void);
void op_register_dynamics(void);
void op_register_construction(void);
void op_register_optimizer(void);
void op_register_track(void);
void op_register_abi(void);
void op_register_canonical(void);
void op_register_oracle(void);
void op_register_playback(void);

/* Fixture directory injected by the build (OPTILINE_FIXTURE_DIR). */
const char *op_test_fixture_dir(void);

#endif /* OPTILINE_TEST_RUNNER_H */
