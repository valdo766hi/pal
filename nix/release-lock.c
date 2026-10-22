#include <sys/file.h>

int main(void) {
  return flock(3, LOCK_EX | LOCK_NB) == 0 ? 0 : 1;
}
