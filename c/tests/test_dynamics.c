#include <math.h>
#include <string.h>
#include "optiline/op_dynamics.h"
#include "test_runner.h"

static op_vehicle vehicle(void){op_vehicle v;memset(&v,0,sizeof v);v.mass=900;v.v_max=80;v.ax_plus0=6;v.ax_minus0=14;v.ay0=15;v.ellipse_p=2;v.rho_air=1.225;v.cda=1;v.cla=3;v.gravity=9.80665;return v;}
static void aero_and_circle_cap(void){op_vehicle v=vehicle();op_aero a=op_dynamics_aero(&v);double q=op_dynamics_q_cap(&v,&a,0.02);
    OP_ASSERT_NEAR(a.delta,1.225/1800.0,1e-15);OP_ASSERT(a.gamma>0);OP_ASSERT(q>0&&q<=6400);
    OP_ASSERT_NEAR(q*0.02/(v.ay0*(1+a.gamma*q)),1.0,1e-12);}
static void lateral_cap_and_net_bounds(void){op_vehicle v=vehicle();op_aero a;
    v.cda=0;v.cla=0;a=op_dynamics_aero(&v);
    OP_ASSERT_NEAR(op_dynamics_q_cap(&v,&a,0.02),750.0,1e-12);
    OP_ASSERT_NEAR(op_dynamics_net_accel(&v,&a,100.0,0.0),6.0,1e-12);
    OP_ASSERT_NEAR(op_dynamics_net_brake(&v,&a,100.0,0.0),14.0,1e-12);
    OP_ASSERT_NEAR(op_dynamics_net_accel(&v,&a,375.0,0.02),
                   6.0*sqrt(0.75),1e-12);}
static void drag_terminal_speed(void){op_vehicle v=vehicle();op_aero a;v.cla=0;a=op_dynamics_aero(&v);
    double q_terminal=v.ax_plus0/a.delta;
    OP_ASSERT_NEAR(op_dynamics_net_accel(&v,&a,q_terminal,0.0),0.0,1e-12);
    OP_ASSERT(op_dynamics_net_accel(&v,&a,1.01*q_terminal,0.0)<0.0);}
static void closed_constant_curvature(void){op_vehicle v=vehicle();op_dyn_grid grid;double q[OP_MAX_PROFILE_EDGES],residual;int i;
    memset(&grid,0,sizeof grid);v.cda=0;v.cla=0;grid.edge_count=16;
    for(i=0;i<grid.edge_count;i++){grid.ds[i]=20;grid.K[i]=0.02;grid.kappa_node[i]=0.02;}
    OP_ASSERT_EQ_INT(op_dynamics_solve_envelope(&v,&grid,q,&residual),OP_OK);
    for(i=0;i<grid.edge_count;i++)OP_ASSERT_NEAR(q[i],750.0*(1.0-1e-8),2e-4);
    OP_ASSERT(residual<=1e-10);}
void op_register_dynamics(void){op_test_add("dynamics","aero_and_cap",aero_and_circle_cap);
    op_test_add("dynamics","lateral_cap_and_net_bounds",lateral_cap_and_net_bounds);
    op_test_add("dynamics","drag_terminal_speed",drag_terminal_speed);
    op_test_add("dynamics","closed_constant_curvature",closed_constant_curvature);}
