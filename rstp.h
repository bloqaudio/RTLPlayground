/*
 * Portable RSTP (802.1w, single spanning tree) core for RTLPlayground.
 * No hardware access here: the platform glue (rtl837x_stp.c) feeds link
 * events, received BPDUs and a 500 ms tick, and provides the callbacks
 * at the bottom.  All multi-byte protocol fields are kept big-endian so
 * priority vectors compare with a plain byte loop.
 * This code is in the Public Domain
 */
#ifndef _RSTP_H_
#define _RSTP_H_

#include <stdint.h>

#ifndef __SDCC
#define __xdata
#define __banked
#endif

#define RSTP_MAX_PORTS	9

/* port roles */
#define RSTP_R_DISABLED		0
#define RSTP_R_ROOT		1
#define RSTP_R_DESIGNATED	2
#define RSTP_R_ALTERNATE	3
#define RSTP_R_BACKUP		4

/* port states (also the values handed to rstp_platform_state) */
#define RSTP_S_DISCARDING	0
#define RSTP_S_LEARNING		1
#define RSTP_S_FORWARDING	2

/* admin edge modes */
#define RSTP_EDGE_AUTO		0
#define RSTP_EDGE_ON		1
#define RSTP_EDGE_OFF		2

/* BPDU types */
#define RSTP_BPDU_CONFIG	0x00
#define RSTP_BPDU_TCN		0x80
#define RSTP_BPDU_RST		0x02

/* BPDU flag bits */
#define RSTP_F_TC		0x01
#define RSTP_F_PROPOSAL		0x02
#define RSTP_F_ROLE_MASK	0x0c	/* 1=alt/backup 2=root 3=designated */
#define RSTP_F_ROLE_ALT		0x04
#define RSTP_F_ROLE_ROOT	0x08
#define RSTP_F_ROLE_DESIG	0x0c
#define RSTP_F_LEARNING		0x10
#define RSTP_F_FORWARDING	0x20
#define RSTP_F_AGREEMENT	0x40
#define RSTP_F_TCACK		0x80

/* priority vector: root_id[8] cost[4] bridge_id[8] port_id[2], all
 * big-endian => lexicographic byte compare == 802.1w vector compare */
#define RSTP_VEC_LEN	22
#define V_ROOT		0
#define V_COST		8
#define V_BRIDGE	12
#define V_PORT		20

/* decoded BPDU handed in by the platform */
struct rstp_bpdu {
	uint8_t type;			/* RSTP_BPDU_* */
	uint8_t flags;
	uint8_t vec[RSTP_VEC_LEN];	/* as received; undefined for TCN */
};

struct rstp_port {
	uint8_t vec[RSTP_VEC_LEN];	/* port priority (designated info) */
	uint8_t cost[4];		/* our path cost on this port, BE */
	uint8_t role;
	uint8_t state;
	uint8_t link;
	uint8_t admin_edge;		/* RSTP_EDGE_* */
	uint8_t oper_edge;
	uint8_t send_rstp;		/* 0: STP-compat peer on this port */
	uint8_t proposed;		/* rcvd proposal, not yet answered */
	uint8_t agreed;			/* rcvd agreement for our proposal */
	uint8_t new_info;		/* send a BPDU asap */
	uint8_t tc_ack;			/* set TCack in next config BPDU */
	uint8_t rcvd_bpdu;		/* any BPDU ever seen since link up */
	/* timers, 500 ms units */
	uint8_t hello_when;
	uint8_t fd_while;
	uint8_t rcvd_info_while;
	uint8_t tc_while;
	uint8_t mdelay_while;
	uint8_t edge_delay;
};

extern __xdata struct rstp_port rstp_ports[RSTP_MAX_PORTS];
extern __xdata uint8_t rstp_bridge_id[8];	/* set by glue before init */
extern __xdata uint8_t rstp_nports;		/* set by glue before init */
extern __xdata uint8_t rstp_root_vec[RSTP_VEC_LEN];
extern __xdata uint8_t rstp_root_port;	/* 0xff: we are root */

/* Internal (128 B) RAM on the 8051 is nearly exhausted, so this API
 * avoids multi-byte parameters (SDCC places them in DSEG): inputs and
 * outputs beyond one byte travel through the __xdata globals below. */
extern __xdata struct rstp_bpdu rstp_bpdu_in;	/* glue fills, then rx */
extern __xdata uint8_t rstp_tx_type;		/* core fills before tx */
extern __xdata uint8_t rstp_tx_flags;
extern __xdata uint8_t rstp_tx_vec[RSTP_VEC_LEN];

/* rstp_link up_speed: bit 7 = link up, bits 0-2 = speed class 0-5
 * (10M 100M 1G 2.5G 5G 10G) */
#define RSTP_LINK_UP	0x80

/* core API (called by platform glue) */
void rstp_init(void) __banked;
void rstp_link(uint8_t port, uint8_t up_speed) __banked;
void rstp_rx(uint8_t port) __banked;
void rstp_tick500(void) __banked;
void rstp_set_edge(uint8_t port, uint8_t mode) __banked;

/* provided by platform glue */
void rstp_platform_state(uint8_t port, uint8_t state);
void rstp_platform_tx(uint8_t port);
void rstp_platform_flush(void);

#endif
