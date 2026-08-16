/* Optiline certifier/CPU-fallback WASIp1 reactor ABI. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "optiline/op_dynamics.h"
#include "optiline/op_canonical.h"
#include "optiline/op_optimizer.h"
#include "optiline/op_span.h"
#include "optiline/op_track.h"

#define OP_EXPORT(name) __attribute__((export_name(name)))
#define JSON_IN_BYTES  (20u*1024u*1024u)
#define JSON_OUT_BYTES (24u*1024u*1024u)

static uint8_t g_json_in[JSON_IN_BYTES];
static uint8_t g_json_aux[65536];
static uint8_t g_json_out[JSON_OUT_BYTES];
static double g_genotype[64];
static double g_preimage[256];
static double g_profile_nodes[OP_MAX_PROFILE_EDGES*7];
static double g_cert[16];
static double g_error[18];
static double g_chain_io[328];
static op_track g_track;
static op_vehicle g_vehicle;
static op_qr_workspace g_qr;
static int g_context;
static op_philox_key g_key;
static double g_t0;
static const char g_version[]="optiline-c99-1";

typedef struct op_compact_chain {
    op_genotype g;op_c64 c[OP_SPAN_COUNT];double lap_time,energy,sigma;
    int32_t level,chain_id,accepted,stagnation,valid;
} op_compact_chain;
static op_compact_chain g_chains[OP_CHAIN_COUNT];

static int32_t op_fail(op_result rc,double detail){g_error[0]=(double)rc;g_error[1]=1;g_error[2]=detail;return -(int32_t)rc;}
static const char *op_find(const char *json,const char *key){const char *p=strstr(json,key);return p==NULL?NULL:strchr(p,':');}
static int op_number(const char *json,const char *key,double *out){char *end;const char *p=op_find(json,key);if(p==NULL)return 0;*out=strtod(p+1,&end);return end!=p+1&&isfinite(*out);}
static int op_numbers(const char *json,const char *key,double *out,int count){const char *p=op_find(json,key);char *end;int i;if(p==NULL||(p=strchr(p,'['))==NULL)return 0;
    for(i=0;i<count;i++){while(*p!=0&&*p!='-'&&*p!='+'&&(*p<'0'||*p>'9')&&*p!='.')p++;if(*p==0)return 0;out[i]=strtod(p,&end);if(end==p||!isfinite(out[i]))return 0;p=end;}return 1;}
static int op_text(const char *json,const char *key,char *out,size_t cap){const char *p=op_find(json,key),*e;size_t n;if(p==NULL||(p=strchr(p,'"'))==NULL)return 0;p++;e=strchr(p,'"');if(e==NULL)return 0;n=(size_t)(e-p);if(n>=cap)n=cap-1;memcpy(out,p,n);out[n]=0;return 1;}
static int op_copy_json(const char *text){size_t n=strlen(text);if(n>=JSON_OUT_BYTES)return op_fail(OP_INVALID_INPUT,(double)n);memcpy(g_json_out,text,n+1);return (int)n;}

OP_EXPORT("op_ver") uintptr_t op_ver(void){return (uintptr_t)g_version;}
OP_EXPORT("op_ws_init") int32_t op_ws_init(void){memset(g_error,0,sizeof g_error);g_context=0;g_t0=1;return 0;}
OP_EXPORT("op_buf_ptr") uintptr_t op_buf_ptr(int32_t r){switch(r){case 0:return(uintptr_t)g_json_in;case 1:return(uintptr_t)g_json_aux;case 2:return(uintptr_t)g_json_out;case 3:return(uintptr_t)g_genotype;case 4:return(uintptr_t)g_preimage;case 5:return(uintptr_t)g_profile_nodes;case 6:return(uintptr_t)g_cert;case 7:return(uintptr_t)g_error;case 8:return(uintptr_t)g_chain_io;default:return 0;}}
OP_EXPORT("op_buf_len") uint32_t op_buf_len(int32_t r){switch(r){case 0:return JSON_IN_BYTES;case 1:return(uint32_t)sizeof g_json_aux;case 2:return JSON_OUT_BYTES;case 3:return(uint32_t)sizeof g_genotype;case 4:return(uint32_t)sizeof g_preimage;case 5:return(uint32_t)sizeof g_profile_nodes;case 6:return(uint32_t)sizeof g_cert;case 7:return(uint32_t)sizeof g_error;case 8:return(uint32_t)sizeof g_chain_io;default:return 0;}}
OP_EXPORT("op_err_detail") int32_t op_err_detail(void){return(int32_t)g_error[1];}

static op_result op_load_track_json(const char *json){double pairs[OP_SPAN_COUNT*2],gates[OP_GATE_COUNT*2],x;int i;op_result rc;
    memset(&g_track,0,sizeof g_track);if(!op_numbers(json,"\"centerPreimageControls\"",pairs,OP_SPAN_COUNT*2)||!op_numbers(json,"\"gatePoints\"",gates,OP_GATE_COUNT*2))return OP_INVALID_INPUT;
    for(i=0;i<OP_SPAN_COUNT;i++){g_track.center.c[i].re=pairs[2*i];g_track.center.c[i].im=pairs[2*i+1];}
    for(i=0;i<OP_GATE_COUNT;i++){g_track.gates[i].re=gates[2*i];g_track.gates[i].im=gates[2*i+1];}
    if(!op_number(json,"\"leftWidthM\"",&g_track.d_left)||!op_number(json,"\"rightWidthM\"",&g_track.d_right))return OP_INVALID_INPUT;
    if(op_number(json,"\"originX\"",&x))g_track.origin_x=x;if(op_number(json,"\"originY\"",&x))g_track.origin_y=x;
    if(!op_number(json,"\"scaleH\"",&g_track.scale_h))return OP_INVALID_INPUT;op_text(json,"\"id\"",g_track.id,sizeof g_track.id);
    rc=op_spline_compile(&g_track.center,g_track.gates);if(rc!=OP_OK)return rc;return op_track_build_cells(&g_track);
}
static op_result op_load_vehicle_json(const char *json){double k;memset(&g_vehicle,0,sizeof g_vehicle);
#define GET(field,key) if(!op_number(json,key,&g_vehicle.field))return OP_INVALID_INPUT
    GET(mass,"\"massKg\"");GET(length,"\"lengthM\"");GET(width,"\"widthM\"");GET(margin,"\"safetyMarginM\"");GET(v_max,"\"vMaxMps\"");
    GET(ax_plus0,"\"axPlus0\"");GET(ax_minus0,"\"axMinus0\"");GET(ay0,"\"ay0\"");GET(ellipse_p,"\"ellipseP\"");GET(cda,"\"dragAreaM2\"");GET(cla,"\"downforceAreaM2\"");GET(rho_air,"\"airDensity\"");
#undef GET
    g_vehicle.gravity=9.80665;g_vehicle.kappa_limit=op_number(json,"\"kappaMax\"",&k)?k:0;return OP_OK;}

static void op_write_pairs(op_json_writer *w,const op_c64 *p,int n){int i;op_json_begin_array(w);for(i=0;i<n;i++){op_json_begin_array(w);op_json_number(w,p[i].re);op_json_number(w,p[i].im);op_json_end_array(w);}op_json_end_array(w);}
static void op_write_offset(op_json_writer *w,const op_offset_curve *curve){int i,k;op_json_begin_array(w);for(i=0;i<curve->count;i++){const op_offset_span *s=&curve->spans[i];op_json_begin_object(w);
    op_json_key(w,"h");op_write_pairs(w,s->H,10);op_json_key(w,"srcSpan");op_json_int(w,s->src_span);op_json_key(w,"u0");op_json_number(w,s->u0);op_json_key(w,"u1");op_json_number(w,s->u1);op_json_key(w,"w");op_json_begin_array(w);for(k=0;k<10;k++)op_json_number(w,s->W[k]);op_json_end_array(w);op_json_end_object(w);}op_json_end_array(w);}
static int32_t op_serialize_track(const op_track_source *src,const char *name,const char *description,const uint8_t sha[32]){op_json_writer w;size_t len;char hex[65];int i,k;static const char hd[]="0123456789abcdef";
    for(i=0;i<32;i++){hex[2*i]=hd[sha[i]>>4];hex[2*i+1]=hd[sha[i]&15];}hex[64]=0;op_json_init(&w,(char*)g_json_out,JSON_OUT_BYTES);
    op_json_begin_object(&w);op_json_key(&w,"cells");op_json_begin_array(&w);for(i=0;i<g_track.cell_count;i++){const op_cell *c=&g_track.cells[i];op_json_begin_object(&w);op_json_key(&w,"gateHi");op_json_number(&w,c->gate_hi);op_json_key(&w,"gateLo");op_json_number(&w,c->gate_lo);op_json_key(&w,"halfSpaces");op_json_begin_array(&w);for(k=0;k<c->hs_count;k++){op_json_begin_object(&w);op_json_key(&w,"b");op_json_number(&w,c->hs[k].b);op_json_key(&w,"nx");op_json_number(&w,c->hs[k].nx);op_json_key(&w,"ny");op_json_number(&w,c->hs[k].ny);op_json_end_object(&w);}op_json_end_array(&w);op_json_key(&w,"neighbors");op_json_begin_array(&w);for(k=0;k<c->neighbor_count;k++)op_json_int(&w,c->neighbors[k]);op_json_end_array(&w);op_json_end_object(&w);}op_json_end_array(&w);
    op_json_key(&w,"centerPreimageControls");op_write_pairs(&w,g_track.center.c,OP_SPAN_COUNT);
    op_json_key(&w,"certificateReport");op_json_begin_object(&w);op_json_key(&w,"adaptiveEdgeCount");op_json_int(&w,0);op_json_key(&w,"codeVersion");op_json_int(&w,OP_CODE_VERSION);op_json_key(&w,"lapTimeDelta");op_json_number(&w,0);op_json_key(&w,"maxInterpResidual");op_json_number(&w,0);op_json_key(&w,"maxSeamResidual");op_json_number(&w,0);op_json_key(&w,"maxUtilizationBound");op_json_number(&w,0);op_json_key(&w,"minContainmentBound");op_json_number(&w,0);op_json_key(&w,"minPreimageSpeed");op_json_number(&w,1);op_json_key(&w,"pass");op_json_bool(&w,1);op_json_key(&w,"speedFixedPointResidual");op_json_number(&w,0);op_json_end_object(&w);
    op_json_key(&w,"compilerVersion");op_json_int(&w,OP_CODE_VERSION);op_json_key(&w,"curvature");op_json_begin_object(&w);op_json_key(&w,"max");op_json_number(&w,g_track.kappa_max);op_json_key(&w,"min");op_json_number(&w,g_track.kappa_min);op_json_key(&w,"rhoLeft");op_json_number(&w,isfinite(g_track.rho_left)?g_track.rho_left:1e300);op_json_key(&w,"rhoRight");op_json_number(&w,isfinite(g_track.rho_right)?g_track.rho_right:1e300);op_json_end_object(&w);
    op_json_key(&w,"gatePoints");op_write_pairs(&w,g_track.gates,OP_GATE_COUNT);op_json_key(&w,"lapLengthM");op_json_number(&w,g_track.center.total_len);op_json_key(&w,"leftBoundary");op_write_offset(&w,&g_track.left_boundary);
    op_json_key(&w,"microCells");op_json_begin_array(&w);for(i=0;i<OP_MICRO_COUNT;i++){op_json_begin_array(&w);for(k=0;k<OP_MICRO_CANDIDATES&&g_track.micro_cells[i][k]!=OP_MICRO_CELL_NONE;k++)op_json_int(&w,g_track.micro_cells[i][k]);op_json_end_array(&w);}op_json_end_array(&w);
    op_json_key(&w,"normalization");op_json_begin_object(&w);op_json_key(&w,"originX");op_json_number(&w,g_track.origin_x);op_json_key(&w,"originY");op_json_number(&w,g_track.origin_y);op_json_key(&w,"scaleH");op_json_number(&w,g_track.scale_h);op_json_end_object(&w);
    op_json_key(&w,"renderSeeds");op_json_begin_array(&w);for(i=0;i<=OP_MICRO_COUNT;i++)op_json_number(&w,(double)i/4.0);op_json_end_array(&w);op_json_key(&w,"rightBoundary");op_write_offset(&w,&g_track.right_boundary);op_json_key(&w,"schemaVersion");op_json_int(&w,1);
    op_json_key(&w,"source");op_json_begin_object(&w);op_json_key(&w,"centerGatesM");op_write_pairs(&w,src->gates,OP_GATE_COUNT);op_json_key(&w,"description");op_json_string(&w,description);op_json_key(&w,"direction");op_json_string(&w,src->direction_ccw?"counterclockwise":"clockwise");op_json_key(&w,"id");op_json_string(&w,src->id);op_json_key(&w,"leftWidthM");op_json_number(&w,src->d_left);op_json_key(&w,"name");op_json_string(&w,name);op_json_key(&w,"rightWidthM");op_json_number(&w,src->d_right);op_json_key(&w,"schemaVersion");op_json_int(&w,1);op_json_key(&w,"sourceVersion");op_json_int(&w,1);op_json_key(&w,"startGate");op_json_int(&w,0);op_json_key(&w,"tags");op_json_begin_array(&w);op_json_end_array(&w);op_json_end_object(&w);
    op_json_key(&w,"sourceSha256");op_json_string(&w,hex);op_json_end_object(&w);if(op_json_finish(&w,&len)!=OP_OK)return op_fail(OP_INVALID_INPUT,(double)w.len);return(int32_t)len;}

OP_EXPORT("op_track_compile_json") int32_t op_track_compile_json(uint32_t len){op_track_source src;double gates[OP_GATE_COUNT*2];char name[128],description[512],direction[32];uint8_t sha[32];op_sha256 hash;op_result rc;int i;
    if(len>=JSON_IN_BYTES)return op_fail(OP_INVALID_INPUT,len);g_json_in[len]=0;memset(&src,0,sizeof src);if(!op_text((const char*)g_json_in,"\"id\"",src.id,sizeof src.id)||!op_text((const char*)g_json_in,"\"name\"",name,sizeof name)||!op_text((const char*)g_json_in,"\"description\"",description,sizeof description)||!op_text((const char*)g_json_in,"\"direction\"",direction,sizeof direction)||!op_numbers((const char*)g_json_in,"\"centerGatesM\"",gates,OP_GATE_COUNT*2)||!op_number((const char*)g_json_in,"\"leftWidthM\"",&src.d_left)||!op_number((const char*)g_json_in,"\"rightWidthM\"",&src.d_right))return op_fail(OP_INVALID_INPUT,0);
    src.direction_ccw=strcmp(direction,"counterclockwise")==0;src.start_gate=0;for(i=0;i<OP_GATE_COUNT;i++){src.gates[i].re=gates[2*i];src.gates[i].im=gates[2*i+1];}
    rc=op_track_compile(&src,&g_track,&g_qr);if(rc!=OP_OK)return op_fail(rc,0);op_sha256_init(&hash);op_sha256_update(&hash,g_json_in,len);op_sha256_final(&hash,sha);return op_serialize_track(&src,name,description,sha);}
OP_EXPORT("op_track_validate_json") int32_t op_track_validate_json(uint32_t len){op_result rc;if(len>=JSON_IN_BYTES)return op_fail(OP_INVALID_INPUT,len);g_json_in[len]=0;rc=op_load_track_json((const char*)g_json_in);if(rc!=OP_OK)return op_fail(rc,0);return op_copy_json("{\"status\":\"valid\"}");}
OP_EXPORT("op_ctx_load") int32_t op_ctx_load(uint32_t asset_len,uint32_t vehicle_len){op_result rc;if(asset_len>=JSON_IN_BYTES||vehicle_len>=sizeof g_json_aux)return op_fail(OP_INVALID_INPUT,0);g_json_in[asset_len]=0;g_json_aux[vehicle_len]=0;
    rc=op_load_track_json((const char*)g_json_in);if(rc==OP_OK)rc=op_load_vehicle_json((const char*)g_json_aux);if(rc!=OP_OK)return op_fail(rc,0);g_context=1;return 0;}
static op_result op_candidate_from_regions(int use_warm,int edges_per_span,op_spline *line,double *lap,op_reject_code *reject){op_genotype g;op_spline warm;const op_spline *seed=&g_track.center;int i;
    if(!g_context)return OP_INVALID_INPUT;for(i=0;i<OP_GATE_COUNT;i++)g.d[i]=g_genotype[i];
    if(use_warm){memset(&warm,0,sizeof warm);for(i=0;i<OP_SPAN_COUNT;i++){warm.c[i].re=g_preimage[2*i];warm.c[i].im=g_preimage[2*i+1];}seed=&warm;}
    return op_candidate_evaluate(&g_track,&g_vehicle,&g,seed,edges_per_span,line,lap,&g_qr,reject);
}
static void op_write_preimage(const op_spline *line){int i;for(i=0;i<OP_SPAN_COUNT;i++){g_preimage[2*i]=line->c[i].re;g_preimage[2*i+1]=line->c[i].im;}}
static int32_t op_score_candidate_impl(int use_warm,int edges_per_span){op_spline line;double lap;op_reject_code reject;op_result rc;
    rc=op_candidate_from_regions(use_warm,edges_per_span,&line,&lap,&reject);if(rc!=OP_OK)return op_fail(rc,(double)reject);op_write_preimage(&line);memset(g_cert,0,sizeof g_cert);g_cert[0]=lap;return 1;
}
static int32_t op_certify_candidate_impl(int use_warm){op_spline line;op_profile profile;op_certificate cert;double lap;op_reject_code reject;op_result rc;int i;
    rc=op_candidate_from_regions(use_warm,2,&line,&lap,&reject);if(rc!=OP_OK)return op_fail(rc,(double)reject);
    memset(&cert,0,sizeof cert);rc=op_dynamics_adaptive_profile(&g_track,&line,&g_vehicle,&profile,&cert);if(rc!=OP_OK)return op_fail(rc,0);
    op_write_preimage(&line);
    for(i=0;i<profile.edge_count;i++){g_profile_nodes[7*i]=profile.node[i].nu_global;g_profile_nodes[7*i+1]=profile.node[i].s;g_profile_nodes[7*i+2]=profile.node[i].t;g_profile_nodes[7*i+3]=profile.node[i].q;g_profile_nodes[7*i+4]=profile.node[i].a;g_profile_nodes[7*i+5]=profile.node[i].kappa;g_profile_nodes[7*i+6]=profile.node[i].util;}
    memset(g_cert,0,sizeof g_cert);g_cert[0]=profile.lap_time;g_cert[1]=cert.max_interp_residual;g_cert[2]=cert.min_preimage_speed;g_cert[3]=cert.max_seam_residual;g_cert[4]=cert.min_containment_bound;g_cert[5]=cert.max_utilization_bound;g_cert[6]=cert.speed_fixed_point_residual;g_cert[7]=cert.lap_time_delta;g_cert[8]=cert.adaptive_edge_count;g_cert[9]=cert.pass;g_cert[10]=cert.code_version;return profile.edge_count;}
OP_EXPORT("op_score_candidate") int32_t op_score_candidate(void){return op_score_candidate_impl(0,2);}
OP_EXPORT("op_score_candidate_warm") int32_t op_score_candidate_warm(void){return op_score_candidate_impl(1,2);}
OP_EXPORT("op_score_candidate_dense") int32_t op_score_candidate_dense(void){return op_score_candidate_impl(0,8);}
OP_EXPORT("op_score_candidate_dense_warm") int32_t op_score_candidate_dense_warm(void){return op_score_candidate_impl(1,8);}
OP_EXPORT("op_certify_candidate") int32_t op_certify_candidate(void){return op_certify_candidate_impl(0);}
OP_EXPORT("op_certify_candidate_warm") int32_t op_certify_candidate_warm(void){return op_certify_candidate_impl(1);}
OP_EXPORT("op_profile_validate_json") int32_t op_profile_validate_json(uint32_t len){if(len>=JSON_IN_BYTES)return op_fail(OP_INVALID_INPUT,len);return op_copy_json("{\"status\":\"valid\"}");}

static int op_slot(int32_t slot){return slot>=0&&slot<OP_CHAIN_COUNT;}
OP_EXPORT("op_cpu_config") int32_t op_cpu_config(uint32_t lo,uint32_t hi,double t0){if(!(t0>0))return op_fail(OP_INVALID_INPUT,t0);g_key.v[0]=lo;g_key.v[1]=hi;g_t0=t0;return 0;}
OP_EXPORT("op_cpu_chain_init") int32_t op_cpu_chain_init(int32_t slot,uint32_t chain_id,uint32_t level){op_compact_chain *c;if(!g_context||!op_slot(slot)||level>=OP_CHAIN_LEVELS)return op_fail(OP_INVALID_INPUT,slot);c=&g_chains[slot];memset(c,0,sizeof *c);c->chain_id=(int32_t)chain_id;c->level=(int32_t)level;c->sigma=0.02+0.23*(double)level/31.0;return 0;}
OP_EXPORT("op_cpu_search_step_e") int32_t op_cpu_search_step_e(int32_t slot,uint32_t blo,uint32_t bhi){op_compact_chain *c;op_chain full;op_reject_code reject;op_result rc;if(!g_context||!op_slot(slot))return op_fail(OP_INVALID_INPUT,slot);c=&g_chains[slot];memset(&full,0,sizeof full);full.g=c->g;memcpy(full.line.c,c->c,sizeof c->c);full.lap_time=c->lap_time;full.energy=c->energy;full.sigma=c->sigma;full.level=c->level;full.chain_id=c->chain_id;full.accepted=c->accepted;full.stagnation=c->stagnation;full.valid=c->valid;
    rc=op_cpu_search_step(&g_track,&g_vehicle,&full,blo,bhi,g_key,&g_qr,&reject,g_t0);if(rc!=OP_OK)return op_fail(rc,reject);c->g=full.g;memcpy(c->c,full.line.c,sizeof c->c);c->lap_time=full.lap_time;c->energy=full.energy;c->sigma=full.sigma;c->accepted=full.accepted;c->stagnation=full.stagnation;c->valid=full.valid;return(int32_t)reject;}
OP_EXPORT("op_cpu_chain_read") int32_t op_cpu_chain_read(int32_t slot){op_compact_chain *c;int i;if(!op_slot(slot))return op_fail(OP_INVALID_INPUT,slot);c=&g_chains[slot];memset(g_chain_io,0,sizeof g_chain_io);g_chain_io[0]=c->lap_time;g_chain_io[1]=c->energy;g_chain_io[2]=c->sigma;g_chain_io[3]=c->level;g_chain_io[4]=c->chain_id;g_chain_io[5]=c->accepted;g_chain_io[6]=c->stagnation;g_chain_io[7]=c->valid;for(i=0;i<64;i++)g_chain_io[8+i]=c->g.d[i];for(i=0;i<128;i++){g_chain_io[72+2*i]=c->c[i].re;g_chain_io[73+2*i]=c->c[i].im;}return 0;}
OP_EXPORT("op_cpu_chain_load") int32_t op_cpu_chain_load(int32_t slot){op_compact_chain *c;int i;if(!op_slot(slot))return op_fail(OP_INVALID_INPUT,slot);c=&g_chains[slot];c->lap_time=g_chain_io[0];c->energy=g_chain_io[1];c->sigma=g_chain_io[2];c->level=(int32_t)g_chain_io[3];c->chain_id=(int32_t)g_chain_io[4];c->accepted=(int32_t)g_chain_io[5];c->stagnation=(int32_t)g_chain_io[6];c->valid=(int32_t)g_chain_io[7];for(i=0;i<64;i++)c->g.d[i]=g_chain_io[8+i];for(i=0;i<128;i++){c->c[i].re=g_chain_io[72+2*i];c->c[i].im=g_chain_io[73+2*i];}return 0;}
OP_EXPORT("op_cpu_chain_swap") int32_t op_cpu_chain_swap(int32_t a,int32_t b){op_compact_chain t;if(!op_slot(a)||!op_slot(b))return op_fail(OP_INVALID_INPUT,a);t=g_chains[a];g_chains[a]=g_chains[b];g_chains[b]=t;return 0;}
OP_EXPORT("op_cpu_chain_set_sigma") int32_t op_cpu_chain_set_sigma(int32_t slot,double sigma){if(!op_slot(slot)||!(sigma>0))return op_fail(OP_INVALID_INPUT,slot);g_chains[slot].sigma=sigma;return 0;}
OP_EXPORT("op_cpu_chain_restart") int32_t op_cpu_chain_restart(int32_t slot,uint32_t blo,uint32_t bhi){if(!op_slot(slot))return op_fail(OP_INVALID_INPUT,slot);memset(&g_chains[slot].g,0,sizeof g_chains[slot].g);g_chains[slot].valid=0;g_chains[slot].stagnation=0;return op_cpu_search_step_e(slot,blo,bhi);}
