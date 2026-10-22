#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#endif
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 1) return flock(3, LOCK_EX | LOCK_NB) == 0 ? 0 : 1;
  if (argc != 2 || strcmp(argv[1], "--path") != 0) return 1;
  char path[PATH_MAX];
#ifdef __APPLE__
  if (fcntl(3, F_GETPATH, path) == -1) return 1;
  size_t length = strnlen(path, sizeof(path));
#else
  ssize_t count = readlink("/proc/self/fd/3", path, sizeof(path));
  if (count < 0) return 1;
  size_t length = (size_t)count;
#endif
  if (length == sizeof(path)) return 1;
  return fwrite(path, 1, length, stdout) == length && fflush(stdout) == 0 ? 0 : 1;
}
