/*
 * sdcc_shim.h — neutralize SDCC 8051 keywords so firmware translation units
 * compile under host gcc/clang for off-target unit testing.
 *
 * Force-included (gcc -include) ahead of every firmware source under test.
 * It only erases storage/qualifier keywords and the banked-call attribute;
 * it does NOT change any logic, so the code under test is byte-for-byte the
 * firmware source. Hardware/register access is provided by mocks (support.c),
 * never by this file.
 */
#ifndef SDCC_SHIM_H
#define SDCC_SHIM_H

/* Memory-space qualifiers → nothing (host has one flat address space). */
#define __xdata
#define __code
#define __pdata
#define __idata
#define __data
#define __bit         unsigned char
#define __sbit        unsigned char

/* NOTE: the firmware ships its own 8051 memcpy/memset/strlen/strcpy/sleep with
 * incompatible signatures (rtl837x_common.h). Host TUs must therefore build with
 * -fno-builtin (so gcc doesn't auto-declare the builtins) and must NOT include
 * <string.h>/<unistd.h>. Test code uses the t_* helpers in support.h instead. */

/* Function attributes → nothing (no banking / no 8051 calling conventions). */
#define __banked
#define __reentrant
#define __naked
#define __using(n)
#define __interrupt(n)
#define __at(addr)

#endif /* SDCC_SHIM_H */
