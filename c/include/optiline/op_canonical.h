/* Optiline — canonical JSON serialization for fingerprints (§20.5).
 * UTF-8, sorted keys, no insignificant whitespace, ECMAScript shortest
 * round-tripping number form. Native tests must produce byte-identical
 * output to the TypeScript canonicalizer. */
#ifndef OPTILINE_OP_CANONICAL_H
#define OPTILINE_OP_CANONICAL_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Shortest round-tripping decimal for a finite binary64, ECMAScript
 * Number::toString(10) semantics. buf must hold >= 32 bytes; returns
 * written length (no NUL padding guarantees beyond the terminator). */
op_result op_canonical_number(double x, char *buf, size_t cap, size_t *len);

/* Minimal canonical JSON writer over a caller buffer. */
typedef struct op_json_writer {
    char   *buf;
    size_t  cap;
    size_t  len;
    int32_t error;
    int32_t depth;
    uint8_t kind[32];       /* 1 object, 2 array */
    uint32_t count[32];
    uint8_t after_key[32];
} op_json_writer;

void      op_json_init(op_json_writer *w, char *buf, size_t cap);
void      op_json_begin_object(op_json_writer *w);
void      op_json_end_object(op_json_writer *w);
void      op_json_begin_array(op_json_writer *w);
void      op_json_end_array(op_json_writer *w);
/* Keys must be provided in sorted order by the caller. */
void      op_json_key(op_json_writer *w, const char *key);
void      op_json_string(op_json_writer *w, const char *s);
void      op_json_bool(op_json_writer *w, int value);
void      op_json_number(op_json_writer *w, double x);
void      op_json_int(op_json_writer *w, int64_t x);
op_result op_json_finish(op_json_writer *w, size_t *len);

/* SHA-256 (for fingerprint parity tests with Web Crypto). */
typedef struct op_sha256 { uint32_t h[8]; uint64_t bits; uint8_t block[64]; uint32_t fill; } op_sha256;
void op_sha256_init(op_sha256 *s);
void op_sha256_update(op_sha256 *s, const uint8_t *data, size_t n);
void op_sha256_final(op_sha256 *s, uint8_t digest[32]);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_CANONICAL_H */
