#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#endif
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc.h>
#endif

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "--running") != 0 && strcmp(argv[1], "--cwd") != 0)) return 2;
  char *end;
  errno = 0;
  long value = strtol(argv[2], &end, 10);
  if (errno != 0 || *end != '\0' || value < 1 || value > INT_MAX) return 2;
  pid_t pid = (pid_t)value;
  int running = 0;
  char path[PATH_MAX];
  size_t length = 0;
#ifdef __APPLE__
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) {
    if (kill(pid, 0) != -1 || errno != ESRCH) return 2;
  } else {
    running = info.pbi_status != SZOMB;
  }
  if (running && strcmp(argv[1], "--cwd") == 0) {
    struct proc_vnodepathinfo paths;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != sizeof(paths)) return 2;
    length = strnlen(paths.pvi_cdir.vip_path, sizeof(paths.pvi_cdir.vip_path));
    if (length == sizeof(paths.pvi_cdir.vip_path) || length >= sizeof(path)) return 2;
    memcpy(path, paths.pvi_cdir.vip_path, length);
  }
#else
  char source[64], line[4096];
  if (snprintf(source, sizeof(source), "/proc/%d/stat", pid) < 0) return 2;
  FILE *file = fopen(source, "r");
  if (file == NULL) {
    if (errno != ENOENT) return 2;
  } else {
    if (fgets(line, sizeof(line), file) == NULL) { fclose(file); return 2; }
    if (fclose(file) != 0) return 2;
    char *name = strrchr(line, ')');
    if (name == NULL || strlen(name) < 3) return 2;
    running = name[2] != 'Z' && name[2] != 'X';
  }
  if (running && strcmp(argv[1], "--cwd") == 0) {
    if (snprintf(source, sizeof(source), "/proc/%d/cwd", pid) < 0) return 2;
    ssize_t count = readlink(source, path, sizeof(path));
    if (count <= 0 || (size_t)count == sizeof(path)) return 2;
    length = (size_t)count;
  }
#endif
  if (strcmp(argv[1], "--running") == 0) {
    const char *state = running ? "running" : "stopped";
    return fputs(state, stdout) >= 0 && fflush(stdout) == 0 ? 0 : 2;
  }
  return fwrite(path, 1, length, stdout) == length && fflush(stdout) == 0 ? 0 : 2;
}
