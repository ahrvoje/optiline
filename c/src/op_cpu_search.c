/* Optiline - deterministic CPU reference for candidate evaluation and search. */
#include <float.h>
#include <math.h>
#include <string.h>

#include "optiline/op_containment.h"
#include "optiline/op_dynamics.h"
#include "optiline/op_math.h"
#include "optiline/op_optimizer.h"
#include "optiline/op_selfint.h"

static op_reject_code op_reject_for_result(op_result rc) {
    switch (rc) {
    case OP_PH_RANK_DEFICIENT: return OP_REJECT_PROJECTION_RANK_FAILURE;
    case OP_PH_PROJECTION_FAILED: return OP_REJECT_PROJECTION_NO_DESCENT;
    case OP_PH_INTERPOLATION_RESIDUAL: return OP_REJECT_INTERPOLATION_RESIDUAL;
    case OP_PH_IRREGULAR: return OP_REJECT_IRREGULAR_PREIMAGE;
    case OP_PH_SELF_INTERSECTION: return OP_REJECT_RACING_LINE_SELF_INTERSECTION;
    case OP_RECTANGLE_NOT_CONTAINED: return OP_REJECT_RECTANGLE_OUTSIDE_CORRIDOR;
    case OP_DYNAMIC_PROFILE_FAILED: return OP_REJECT_DYNAMIC_INFEASIBLE;
    default: return OP_REJECT_NONFINITE_INPUT;
    }
}

op_result op_candidate_evaluate(const op_track *track,const op_vehicle *veh,
                                const op_genotype *g,const op_spline *warm,
                                int32_t edges_per_span,op_spline *line_out,
                                double *lap_time_out,op_qr_workspace *ws,
                                op_reject_code *reject_out) {
    op_dyn_grid grid;
    op_profile profile;
    double residual;
    int32_t i;
    op_result rc;
    if(reject_out!=NULL)*reject_out=OP_REJECT_NONFINITE_INPUT;
    if(track==NULL||veh==NULL||g==NULL||line_out==NULL||lap_time_out==NULL||ws==NULL)
        return OP_INVALID_INPUT;
    for(i=0;i<OP_GATE_COUNT;i++)if(!op_is_finite(g->d[i])||g->d[i]<-track->d_right||g->d[i]>track->d_left)
        return OP_INVALID_INPUT;
    rc=op_construction_build(track,g,warm,line_out,ws,&residual);
    if(rc!=OP_OK)goto fail;
    if(!(line_out->total_len>0.0)){rc=OP_PH_IRREGULAR;if(reject_out!=NULL)*reject_out=OP_REJECT_NONPOSITIVE_LENGTH;return rc;}
    rc=op_selfint_certify_spline(line_out);if(rc!=OP_OK)goto fail;
    rc=op_containment_certify(track,line_out,veh,NULL);if(rc!=OP_OK)goto fail;
    rc=op_dynamics_build_grid(line_out,edges_per_span,0,&grid);if(rc!=OP_OK)goto fail;
    if(veh->kappa_limit>0.0){for(i=0;i<grid.edge_count;i++)if(grid.K[i]>veh->kappa_limit){
        if(reject_out!=NULL)*reject_out=OP_REJECT_CURVATURE_LIMIT;return OP_DYNAMIC_PROFILE_FAILED;}}
    rc=op_dynamics_profile(veh,&grid,&profile);if(rc!=OP_OK)goto fail;
    if(!op_is_finite(profile.lap_time)){if(reject_out!=NULL)*reject_out=OP_REJECT_NONFINITE_LAP_TIME;return OP_DYNAMIC_PROFILE_FAILED;}
    *lap_time_out=profile.lap_time;if(reject_out!=NULL)*reject_out=OP_REJECT_VALID;return OP_OK;
fail:
    if(reject_out!=NULL)*reject_out=op_reject_for_result(rc);return rc;
}

op_result op_cpu_search_step(const op_track *track,const op_vehicle *veh,
                             op_chain *chain,uint32_t batch_lo,uint32_t batch_hi,
                             op_philox_key key,op_qr_workspace *ws,
                             op_reject_code *reject_out,double t0_seed_lap_time) {
    op_philox_ctr ctr;uint32_t words[4],draw=1;op_genotype proposal;op_spline line;
    double z,lap,energy,tau,accept_u;int gate,three,i;op_result rc;
    if(track==NULL||veh==NULL||chain==NULL||ws==NULL||!(chain->sigma>0.0)||!(t0_seed_lap_time>0.0))
        return OP_INVALID_INPUT;
    if(!chain->valid){
        rc=op_candidate_evaluate(track,veh,&chain->g,&track->center,2,
                                 &line,&lap,ws,reject_out);
        if(rc!=OP_OK)return rc;
        chain->line=line;chain->lap_time=lap;
        chain->energy=(lap-t0_seed_lap_time)/t0_seed_lap_time;
        chain->valid=1;
    }
    ctr.v[0]=batch_lo;ctr.v[1]=batch_hi;ctr.v[2]=(uint32_t)chain->chain_id;ctr.v[3]=0;
    op_philox4x32_10(ctr,key,words);gate=(int)(words[0]%OP_GATE_COUNT);three=(words[1]&7u)==0u;
    z=op_philox_normal(batch_lo,batch_hi,(uint32_t)chain->chain_id,&draw,key);
    proposal=chain->g;
    if(three){static const double wt[3]={0.25,0.5,0.25};for(i=0;i<3;i++){
        int gi=(gate+i+OP_GATE_COUNT-1)%OP_GATE_COUNT;
        proposal.d[gi]=op_reflect(proposal.d[gi]+wt[i]*chain->sigma*z,-track->d_right,track->d_left);}}
    else proposal.d[gate]=op_reflect(proposal.d[gate]+chain->sigma*z,-track->d_right,track->d_left);
    rc=op_candidate_evaluate(track,veh,&proposal,
                             chain->valid?&chain->line:&track->center,
                             2,&line,&lap,ws,reject_out);
    if(rc!=OP_OK){chain->stagnation++;return OP_OK;}
    energy=(lap-t0_seed_lap_time)/t0_seed_lap_time;tau=op_optimizer_tau(chain->level);
    ctr.v[3]=draw;op_philox4x32_10(ctr,key,words);accept_u=op_philox_uniform(words[0]);
    if(!chain->valid||energy<=chain->energy||accept_u<exp((chain->energy-energy)/tau)){
        chain->g=proposal;chain->line=line;chain->lap_time=lap;chain->energy=energy;
        chain->accepted++;chain->stagnation=0;chain->valid=1;return OP_OK;
    }
    chain->stagnation++;return OP_OK;
}
