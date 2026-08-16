#include <math.h>
#include <string.h>
#include "optiline/op_dynamics.h"
#include "test_runner.h"

static op_vehicle vehicle(void){op_vehicle v;memset(&v,0,sizeof v);v.mass=900;v.v_max=80;v.ax_plus0=6;v.ax_minus0=14;v.ay0=15;v.ellipse_p=2;v.rho_air=1.225;v.cda=1;v.cla=3;v.gravity=9.80665;return v;}
static void aero_and_circle_cap(void){op_vehicle v=vehicle();op_aero a=op_dynamics_aero(&v);double q=op_dynamics_q_cap(&v,&a,0.02);
    OP_ASSERT_NEAR(a.delta,1.225/1800.0,1e-15);OP_ASSERT(a.gamma>0);OP_ASSERT(q>0&&q<=6400);OP_ASSERT(op_dynamics_utilization(&v,&a,q,0,0.02)<=1.000001);}
void op_register_dynamics(void){op_test_add("dynamics","aero_and_cap",aero_and_circle_cap);}
