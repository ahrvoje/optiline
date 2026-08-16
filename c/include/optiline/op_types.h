/* Optiline — shared authoritative C99 types and constants.
 *
 * This header is the cross-module contract (PROJECT_SPECIFICATION.md §5, §6.1,
 * §7, §8, §11, §12, Appendix C). It compiles unchanged under MSVC /TC /std:c17
 * and WASI SDK Clang -std=c99. No VLAs, no <complex.h>, no threads/atomics.
 */
#ifndef OPTILINE_OP_TYPES_H
#define OPTILINE_OP_TYPES_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* Stable result codes (Appendix C). Values are frozen for the ABI.   */
/* ------------------------------------------------------------------ */
typedef enum op_result {
    OP_OK                                   = 0,
    OP_INVALID_INPUT                        = 1,
    OP_TRACK_CONSTRUCTION_FAILED            = 2,
    OP_TRACK_OFFSET_CUSP                    = 3,
    OP_TRACK_BOUNDARY_INTERSECTION          = 4,
    OP_CORRIDOR_CERTIFICATE_FAILED          = 5,
    OP_PH_PROJECTION_FAILED                 = 6,
    OP_PH_RANK_DEFICIENT                    = 7,
    OP_PH_IRREGULAR                         = 8,
    OP_PH_INTERPOLATION_RESIDUAL            = 9,
    OP_PH_SELF_INTERSECTION                 = 10,
    OP_PLAYBACK_ARC_LENGTH_INVERSION_FAILED = 11,
    OP_RECTANGLE_NOT_CONTAINED              = 12,
    OP_DYNAMIC_PROFILE_FAILED               = 13,
    OP_DYNAMIC_REFINEMENT_LIMIT             = 14,
    OP_GPU_UNAVAILABLE                      = 15,
    OP_GPU_DEVICE_LOST                      = 16,
    OP_GPU_CERTIFICATION_MISMATCH           = 17,
    OP_PROFILE_INCOMPATIBLE                 = 18,
    OP_PERSISTENCE_FAILED                   = 19,
    OP_STALE_MESSAGE                        = 20
} op_result;

/* GPU / CPU-search mutually exclusive first-failure codes (§14.5). */
typedef enum op_reject_code {
    OP_REJECT_VALID                        = 0,
    OP_REJECT_NONFINITE_INPUT              = 1,
    OP_REJECT_PROJECTION_RANK_FAILURE      = 2,
    OP_REJECT_PROJECTION_NO_DESCENT        = 3,
    OP_REJECT_INTERPOLATION_RESIDUAL       = 4,
    OP_REJECT_IRREGULAR_PREIMAGE           = 5,
    OP_REJECT_NONPOSITIVE_LENGTH           = 6,
    OP_REJECT_RACING_LINE_SELF_INTERSECTION= 7,
    OP_REJECT_RECTANGLE_OUTSIDE_CORRIDOR   = 8,
    OP_REJECT_CURVATURE_LIMIT              = 9,
    OP_REJECT_SPEED_ENVELOPE_NO_CONVERGENCE= 10,
    OP_REJECT_DYNAMIC_INFEASIBLE           = 11,
    OP_REJECT_NONFINITE_LAP_TIME           = 12,
    OP_REJECT_CODE_COUNT                   = 13
} op_reject_code;

/* ------------------------------------------------------------------ */
/* Plain-old-data complex numbers (§6.1).                             */
/* ------------------------------------------------------------------ */
typedef struct op_c64 { double re; double im; } op_c64;
typedef struct op_c32 { float  re; float  im; } op_c32;

/* ------------------------------------------------------------------ */
/* Fixed topology constants (§8.2, §10.4, §12.1, §12.8).              */
/* ------------------------------------------------------------------ */
#define OP_GATE_COUNT        64    /* logical gate intervals N          */
#define OP_SPAN_COUNT        128   /* compiled quadratic spans 2N       */
#define OP_MICRO_COUNT       256   /* containment/dynamics microints    */
#define OP_PERIOD            64.0  /* global preimage period T = N      */
#define OP_SPAN_H            0.5   /* global span width h               */
#define OP_INCUMBENT_EDGES   1024  /* §12.8 initial incumbent grid      */
#define OP_MAX_PROFILE_EDGES 8192  /* §12.8 refinement cap              */
#define OP_ENVELOPE_MAX_ITER_C99 4096
#define OP_REACH_BISECT_STEPS    20

/* Corridor cells (§7.4). Fixed maxima replace variable-length arrays. */
#define OP_MAX_CELL_HALFSPACES 8
#define OP_MICRO_CANDIDATES    8
#define OP_MAX_CELLS           4096
#define OP_MAX_CELL_NEIGHBORS  8

/* Exact rational offsets (§8.9): per-span subdivision list capacity. */
#define OP_MAX_OFFSET_SPANS 2048

/* ------------------------------------------------------------------ */
/* PH span and spline (§8.3–§8.5).                                    */
/* All Bernstein coefficient arrays are ordered by ascending index.   */
/* ------------------------------------------------------------------ */
typedef struct op_span {
    op_c64 b[3];   /* quadratic preimage Bezier controls              */
    op_c64 q[5];   /* degree-4 hodograph Bernstein coefficients       */
    double r[5];   /* degree-4 real speed Bernstein coefficients      */
    op_c64 p[6];   /* degree-5 position Bezier controls               */
    double sA[6];  /* degree-5 arc-length Bezier coefficients A_k     */
    double len;    /* exact span length L = sA[5] = (h/5) * sum r_k   */
} op_span;

typedef struct op_spline {
    op_c64  c[OP_SPAN_COUNT];    /* antiperiodic preimage controls    */
    op_span span[OP_SPAN_COUNT];
    double  cum_len[OP_SPAN_COUNT + 1]; /* Neumaier-compensated       */
    double  total_len;
} op_spline;

/* One rational degree-9 offset span (§8.9), possibly a subdivision of
 * a source PH span over source-local parameter [u0, u1].              */
typedef struct op_offset_span {
    op_c64  H[10];   /* homogeneous numerator controls                */
    double  W[10];   /* weights, all > 0                              */
    double  u0, u1;  /* source-span-local parameter interval          */
    int32_t src_span;/* index into op_spline.span                     */
    int32_t pad_;
} op_offset_span;

typedef struct op_offset_curve {
    int32_t        count;
    int32_t        pad_;
    double         signed_d;   /* signed left offset distance         */
    double         length;     /* L_d = L - 2*pi*n_T*d                */
    op_offset_span spans[OP_MAX_OFFSET_SPANS];
} op_offset_curve;

/* ------------------------------------------------------------------ */
/* Corridor cells (§7.4).                                             */
/* ------------------------------------------------------------------ */
typedef struct op_halfspace { double nx, ny, b; } op_halfspace; /* |n|=1, n.x <= b */

typedef struct op_cell {
    int32_t      hs_count;                       /* 3..8              */
    int32_t      neighbor_count;
    op_halfspace hs[OP_MAX_CELL_HALFSPACES];
    int32_t      neighbors[OP_MAX_CELL_NEIGHBORS];
    double       gate_lo, gate_hi;               /* periodic interval */
} op_cell;

/* ------------------------------------------------------------------ */
/* Compiled track (§7, §20.2). Physical (unnormalized) coordinates.   */
/* ------------------------------------------------------------------ */
typedef struct op_track {
    char       id[64];
    double     origin_x, origin_y;   /* normalization center O        */
    double     scale_h;              /* normalization H > 0           */
    double     d_left, d_right;      /* constant half widths          */
    int32_t    direction_ccw;        /* 1 = counterclockwise source   */
    int32_t    start_gate;           /* always 0 in version 1         */
    op_c64     gates[OP_GATE_COUNT];
    op_spline  center;
    double     rho_left, rho_right;  /* exact one-sided radii (§8.11) */
    double     kappa_min, kappa_max; /* certified centerline extrema  */
    op_offset_curve left_boundary;   /* offset +d_left                */
    op_offset_curve right_boundary;  /* offset -d_right               */
    int32_t    cell_count;
    int32_t    pad_;
    op_cell    cells[OP_MAX_CELLS];
    uint16_t   micro_cells[OP_MICRO_COUNT][OP_MICRO_CANDIDATES]; /* 0xFFFF = none */
} op_track;

#define OP_MICRO_CELL_NONE 0xFFFFu

/* ------------------------------------------------------------------ */
/* Vehicle and dynamics settings (§11.1).                             */
/* ------------------------------------------------------------------ */
typedef struct op_vehicle {
    double mass;        /* kg   */
    double length;      /* m    */
    double width;       /* m    */
    double margin;      /* m    */
    double v_max;       /* m/s  */
    double ax_plus0;    /* m/s^2 base traction  */
    double ax_minus0;   /* m/s^2 base braking   */
    double ay0;         /* m/s^2 base lateral   */
    double ellipse_p;   /* 1..8 */
    double cda;         /* m^2  */
    double cla;         /* m^2  */
    double rho_air;     /* kg/m^3 */
    double gravity;     /* 9.80665 fixed */
    double kappa_limit; /* 1/m; <= 0 means disabled */
} op_vehicle;

/* Derived aero terms (§11.2): delta = rho*CdA/(2 m), gamma = rho*ClA/(2 m g). */
typedef struct op_aero { double delta; double gamma; } op_aero;

/* ------------------------------------------------------------------ */
/* Genotype and periodic speed profile (§9.1, §12).                   */
/* ------------------------------------------------------------------ */
typedef struct op_genotype { double d[OP_GATE_COUNT]; } op_genotype;

typedef struct op_profile_node {
    double nu_global; /* global PH parameter in [0, 64)               */
    double s;         /* cumulative racing-line arc length            */
    double t;         /* cumulative time from start gate              */
    double q;         /* squared speed at node                        */
    double a;         /* constant tangential accel on the edge out    */
    double kappa;     /* signed curvature at node                     */
    double util;      /* stability utilization U at node              */
} op_profile_node;

typedef struct op_profile {
    int32_t         edge_count;      /* periodic: nodes == edges      */
    int32_t         pad_;
    double          lap_time;
    op_profile_node node[OP_MAX_PROFILE_EDGES];
} op_profile;

/* ------------------------------------------------------------------ */
/* Certification record (§23.3).                                      */
/* ------------------------------------------------------------------ */
typedef struct op_certificate {
    double  max_interp_residual;
    double  min_preimage_speed;      /* proven lower bound of |w|^2   */
    double  max_seam_residual;       /* tangent + curvature seam      */
    double  min_containment_bound;
    double  max_utilization_bound;
    double  speed_fixed_point_residual;
    double  lap_time_delta;          /* last refinement level change  */
    int32_t adaptive_edge_count;
    int32_t pass;                    /* op_result                     */
    uint32_t code_version;
    uint32_t pad_;
} op_certificate;

/* Current core code version, stored in every certificate. */
#define OP_CODE_VERSION 1u

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_TYPES_H */
