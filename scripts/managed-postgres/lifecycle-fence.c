/* SPDX-License-Identifier: AGPL-3.0-only
 * A process-associated POSIX record lock survives exec into pg_ctl/initdb,
 * but is not inherited by their forked postmaster/bootstrap children.
 * The lock file is stable for the profile lifetime and is never unlinked. */
#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1
#define _XOPEN_SOURCE 700
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static void fail(const char *message) { perror(message); exit(70); }
static void path(char *out, const char *root, const char *suffix) {
 if (snprintf(out, PATH_MAX, "%s/%s", root, suffix) >= PATH_MAX) { errno=ENAMETOOLONG;fail("native lifecycle path"); }
}
int main(int argc,char **argv) {
 if(argc==2&&!strcmp(argv[1],"--version")){puts("usebrian-posix-lifecycle-fence 1");return 0;}
 if(argc<2||argc>3){fputs("Expected PROFILE [STAGE]\n",stderr);return 64;}
 char profile[PATH_MAX],stage[PATH_MAX],self[PATH_MAX],bin[PATH_MAX],lockpath[PATH_MAX],data[PATH_MAX],logpath[PATH_MAX],pgctl[PATH_MAX],initdb[PATH_MAX],pwfile[PATH_MAX];
 if(!realpath(argv[1],profile)||!realpath(argv[0],self))fail("native lifecycle realpath");
 char *slash=strrchr(self,'/');if(!slash)return 64;*slash='\0';strcpy(bin,self);
 if(strpbrk(profile,"\"$`\\\n\r")||strpbrk(bin,"\"$`\\\n\r")){fputs("Unsupported PostgreSQL tooling path metacharacter\n",stderr);return 64;}
 path(lockpath,profile,argc==3?"lifecycle.fence":"profile-state.fence");path(pgctl,bin,"pg_ctl");path(initdb,bin,"initdb");
 if(argc==3){
  if(!realpath(argv[2],stage))fail("native lifecycle stage");
  char prefix[PATH_MAX];path(prefix,profile,"clusters/cluster-");
  if(strncmp(stage,prefix,strlen(prefix))||strchr(stage+strlen(prefix),'/')){fputs("Native stage is outside its profile\n",stderr);return 64;}
  if(strpbrk(stage,"\"$`\\\n\r")){fputs("Unsupported PostgreSQL tooling path metacharacter\n",stderr);return 64;}
  path(data,stage,"data");path(logpath,stage,"postgres.log");path(pwfile,stage,"initdb-password");
 }
 int fd=open(lockpath,O_RDWR|O_CREAT|O_NOFOLLOW,0600);if(fd<0)fail("native lifecycle fence");
 struct stat st;if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||st.st_nlink!=1){errno=EPERM;fail("native lifecycle fence ownership");}
 int flags=fcntl(fd,F_GETFD);if(flags<0||fcntl(fd,F_SETFD,flags&~FD_CLOEXEC)<0||fcntl(fd,F_GETFD)&FD_CLOEXEC)fail("native lifecycle exec descriptor");
 if(fsync(fd))fail("native lifecycle fence fsync");
 int parent=open(profile,O_RDONLY|O_DIRECTORY);if(parent<0||fsync(parent))fail("native lifecycle profile fsync");close(parent);
 alarm(1200);
 struct flock lock;memset(&lock,0,sizeof(lock));lock.l_type=F_WRLCK;lock.l_whence=SEEK_SET;
 while(fcntl(fd,F_SETLKW,&lock)<0){if(errno!=EINTR)fail("native lifecycle lock");}
 int initguard=-1;
 if(argc==3){
  char guardpath[PATH_MAX];path(guardpath,profile,"initdb-descendants.fence");
  initguard=open(guardpath,O_RDWR|O_CREAT|O_NOFOLLOW,0600);if(initguard<0)fail("native initdb descendant guard");
  struct stat guardst;if(fstat(initguard,&guardst)||!S_ISREG(guardst.st_mode)||guardst.st_uid!=getuid()||guardst.st_nlink!=1){errno=EPERM;fail("native initdb guard ownership");}
  if(flock(initguard,LOCK_EX))fail("native initdb descendants still active");
 }
 puts("LOCKED");fflush(stdout);
 char request[128];if(!fgets(request,sizeof(request),stdin))return 0;
 if(!strcmp(request,"RELEASE\n"))return 0;
 if(argc!=3){fputs("Native action requires its owned stage\n",stderr);return 64;}
 char executorlog[PATH_MAX];path(executorlog,stage,"lifecycle-executor.log");
 int logfd=open(executorlog,O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW,0600);if(logfd<0)fail("native lifecycle action log");
 struct stat logst;if(fstat(logfd,&logst)||!S_ISREG(logst.st_mode)||logst.st_uid!=getuid()||logst.st_nlink!=1){errno=EPERM;fail("native lifecycle log ownership");}
 if(dup2(logfd,STDOUT_FILENO)<0||dup2(logfd,STDERR_FILENO)<0)fail("native lifecycle log redirect");close(logfd);
 if(strcmp(request,"INITDB\n")&&initguard>=0){if(flock(initguard,LOCK_UN))fail("native initdb guard release");close(initguard);initguard=-1;}
 if(!strcmp(request,"STOP\n")){
  char *args[]={pgctl,"-D",data,"-m","fast","-w","-t","15","stop",NULL};execv(pgctl,args);fail("native lifecycle stop exec");
 }
 if(!strcmp(request,"INITDB\n")){
  char *args[]={initdb,"-D",data,"-U","brian_bootstrap","--auth-host=scram-sha-256","--auth-local=scram-sha-256","--encoding=UTF8","--locale=C","--pwfile",pwfile,NULL};execv(initdb,args);fail("native lifecycle initdb exec");
 }
 if(!strncmp(request,"START ",6)){
  char *end=NULL;long port=strtol(request+6,&end,10);if(port<1024||port>65535||!end||strcmp(end,"\n")){fputs("Invalid native lifecycle port\n",stderr);return 64;}
  char options[128];snprintf(options,sizeof(options),"-h 127.0.0.1 -p %ld -k '' -c listen_addresses=127.0.0.1",port);
  char *args[]={pgctl,"-D",data,"-l",logpath,"-w","-t","60","-o",options,"start",NULL};execv(pgctl,args);fail("native lifecycle start exec");
 }
 fputs("Invalid native lifecycle action\n",stderr);return 64;
}
