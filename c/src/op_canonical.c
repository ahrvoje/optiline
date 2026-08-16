/* Optiline - bounded canonical JSON writer for fingerprints and tools. */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "optiline/op_canonical.h"

static void op_putn(op_json_writer *w,const char *s,size_t n) {
    if(w==NULL||w->error)return;
    if(n>w->cap-w->len){w->error=OP_INVALID_INPUT;return;}
    memcpy(w->buf+w->len,s,n);w->len+=n;
}
static void op_putc(op_json_writer *w,char c){op_putn(w,&c,1);}

op_result op_canonical_number(double x,char *buf,size_t cap,size_t *len) {
    char tmp[32],*e;int n;
    if(buf==NULL||len==NULL||cap==0||!isfinite(x))return OP_INVALID_INPUT;
    if(x==0.0){if(cap<2)return OP_INVALID_INPUT;buf[0]='0';buf[1]='\0';*len=1;return OP_OK;}
#ifdef _MSC_VER
    n=_snprintf_s(tmp,sizeof tmp,_TRUNCATE,"%.17g",x);
#else
    n=snprintf(tmp,sizeof tmp,"%.17g",x);
#endif
    if(n<=0||(size_t)n>=sizeof tmp)return OP_INVALID_INPUT;
    e=strchr(tmp,'e');if(e==NULL)e=strchr(tmp,'E');
    if(e!=NULL){char *p=e+1;*e='e';if(*p=='+')memmove(p,p+1,strlen(p));
        if(*p=='-')p++;while(p[0]=='0'&&p[1]!='\0')memmove(p,p+1,strlen(p));}
    n=(int)strlen(tmp);if((size_t)n+1>cap)return OP_INVALID_INPUT;
    memcpy(buf,tmp,(size_t)n+1);*len=(size_t)n;return OP_OK;
}

void op_json_init(op_json_writer *w,char *buf,size_t cap){
    if(w==NULL)return;memset(w,0,sizeof *w);w->buf=buf;w->cap=cap;if(buf==NULL)w->error=OP_INVALID_INPUT;
}
static void op_json_value_prefix(op_json_writer *w){
    int d;if(w->depth<=0)return;d=w->depth-1;
    if(w->kind[d]==1){if(!w->after_key[d]){w->error=OP_INVALID_INPUT;return;}w->after_key[d]=0;w->count[d]++;}
    else {if(w->count[d]!=0)op_putc(w,',');w->count[d]++;}
}
static void op_json_open(op_json_writer *w,char c,uint8_t kind){
    op_json_value_prefix(w);if(w->error)return;if(w->depth>=32){w->error=OP_INVALID_INPUT;return;}
    op_putc(w,c);w->kind[w->depth]=kind;w->count[w->depth]=0;w->after_key[w->depth]=0;w->depth++;
}
void op_json_begin_object(op_json_writer *w){op_json_open(w,'{',1);}
void op_json_begin_array(op_json_writer *w){op_json_open(w,'[',2);}
static void op_json_close(op_json_writer *w,char c,uint8_t kind){
    if(w==NULL||w->error)return;if(w->depth<=0||w->kind[w->depth-1]!=kind||w->after_key[w->depth-1]){w->error=OP_INVALID_INPUT;return;}
    w->depth--;op_putc(w,c);
}
void op_json_end_object(op_json_writer *w){op_json_close(w,'}',1);}
void op_json_end_array(op_json_writer *w){op_json_close(w,']',2);}

static void op_json_raw_string(op_json_writer *w,const char *s){
    const unsigned char *p=(const unsigned char *)s;char esc[7];op_putc(w,'"');
    while(*p!=0&& !w->error){unsigned char c=*p++;switch(c){case '"':op_putn(w,"\\\"",2);break;case '\\':op_putn(w,"\\\\",2);break;
    case '\b':op_putn(w,"\\b",2);break;case '\f':op_putn(w,"\\f",2);break;case '\n':op_putn(w,"\\n",2);break;
    case '\r':op_putn(w,"\\r",2);break;case '\t':op_putn(w,"\\t",2);break;default:
        if(c<0x20u){(void)snprintf(esc,sizeof esc,"\\u%04x",(unsigned)c);op_putn(w,esc,6);}else op_putc(w,(char)c);}}
    op_putc(w,'"');
}
void op_json_key(op_json_writer *w,const char *key){
    int d;if(w==NULL||key==NULL||w->error||w->depth<=0){if(w!=NULL)w->error=OP_INVALID_INPUT;return;}d=w->depth-1;
    if(w->kind[d]!=1||w->after_key[d]){w->error=OP_INVALID_INPUT;return;}if(w->count[d]!=0)op_putc(w,',');
    op_json_raw_string(w,key);op_putc(w,':');w->after_key[d]=1;
}
void op_json_string(op_json_writer *w,const char *s){if(s==NULL){if(w!=NULL)w->error=OP_INVALID_INPUT;return;}op_json_value_prefix(w);op_json_raw_string(w,s);}
void op_json_bool(op_json_writer *w,int value){op_json_value_prefix(w);op_putn(w,value?"true":"false",value?4u:5u);}
void op_json_number(op_json_writer *w,double x){char b[32];size_t n;if(op_canonical_number(x,b,sizeof b,&n)!=OP_OK){w->error=OP_INVALID_INPUT;return;}op_json_value_prefix(w);op_putn(w,b,n);}
void op_json_int(op_json_writer *w,int64_t x){char b[32];int n;op_json_value_prefix(w);n=snprintf(b,sizeof b,"%lld",(long long)x);if(n<=0)w->error=OP_INVALID_INPUT;else op_putn(w,b,(size_t)n);}
op_result op_json_finish(op_json_writer *w,size_t *len){
    if(w==NULL||len==NULL||w->error||w->depth!=0||w->len>=w->cap)return OP_INVALID_INPUT;
    w->buf[w->len]='\0';*len=w->len;return OP_OK;
}
