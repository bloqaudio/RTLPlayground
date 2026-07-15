/*
 * RTL837x platform glue for the portable RSTP core (rstp.c).
 * Owns everything hardware-specific: BPDU frame encode/decode with the
 * RTL CPU tag, MSTP per-port state register writes, link polling and
 * the 500 ms timebase.  The protocol itself lives in rstp.c.
 * This code is in the Public Domain
 */

// #define DEBUG

#include <stdint.h>

#pragma codeseg BANK2

#include "rtl837x_common.h"	/* declares the project's memcpy */
#include "rtl837x_sfr.h"
#include "rtl837x_regs.h"
#include "rtl837x_stp.h"
#include "rtl837x_port.h"
#include "rstp.h"
#include "uip.h"
#include "machine.h"
#include "debug.h"

extern __code struct machine machine;
extern __xdata uint8_t sfr_data[4];
extern __xdata struct uip_eth_addr uip_ethaddr;
extern __xdata uint8_t uip_buf[UIP_CONF_BUFFER_SIZE + 2];
extern volatile __xdata uint32_t ticks;
extern __xdata uint16_t management_vlan;
extern __xdata uint8_t stpEnabled;

/* configurable via `stp prio`, steps of 4096 like everyone else */
__xdata uint16_t stp_bridge_prio;

static __xdata uint16_t last_tick16;

/*
 * Frame offsets.  RX frames carry the 8-byte RTL tag plus a 4-byte VLAN
 * tag between the MACs and the LLC length; TX frames only the RTL tag.
 */
#define RX_LLC		26	/* dsap of a received BPDU */
#define RX_PORT_NIBBLE	19	/* low byte of rtl_tag.pmask: RX port */
#define TX_LEN		20	/* 802.3 length field of a TX frame */

/* map the chip's link-speed nibble to the core's speed class
 * nibble: 0=10M 1=100M 2=1G 3=500M 4=10G 5=2.5G 6=5G */
static const uint8_t speed_class_map[8] = {0, 1, 2, 2, 5, 3, 4, 4};

/* ------------------------------------------------------------------ */
/* callbacks the core needs                                            */
/* ------------------------------------------------------------------ */

/* raw 2-bit field write into the MSTP states register */
static void mstp_write(uint8_t port, uint8_t hw)
{
	static __xdata uint8_t idx, sh;
	idx = 3 - (port >> 2);
	sh = (port << 1) & 0x7;
	reg_read_m(RTL837X_MSTP_STATES);
	sfr_data[idx] = (sfr_data[idx] & ~(0b11 << sh)) | (hw << sh);
	sfr_data[1] |= 0x0c;	/* CPU port (9) stays forwarding */
	reg_write_m(RTL837X_MSTP_STATES);
}

void rstp_platform_state(uint8_t port, uint8_t state)
{
	/* 2-bit fields. Bench-measured on the RTL8373N: only 00 truly
	 * discards - 01 still floods and learns (it behaves like a
	 * listening state), which lets frames leak through "blocked"
	 * ports and poisons MAC tables fabric-wide. BPDUs still reach
	 * the CPU in state 00 (verified: an Alternate port keeps its
	 * role). Learning maps to 00 too: 10 is untested and the risk
	 * of it flooding like 01 outweighs the lost learn phase. */
	mstp_write(port, state == RSTP_S_FORWARDING ? 0b11 : 0b00);
#ifdef DEBUG
	print_string("STP state port "); print_byte(port);
	print_string(" -> "); print_byte(state); write_char('\n');
#endif
}

void rstp_platform_flush(void)
{
	port_l2_forget();
}

void rstp_platform_tx(uint8_t port)
{
	/* frame content starts after the 12-byte TX DMA descriptor;
	 * type/flags/vector arrive in the rstp_tx_* globals */
	static __xdata uint8_t * __xdata f;
	static __xdata uint8_t is_rst, body, type;
	static __xdata uint16_t saved_mgmt_vlan;

	f = uip_buf + RTL_FRAME_DESC_SIZE;
	type = rstp_tx_type;
	is_rst = type == RSTP_BPDU_RST;

	/* DA 01:80:c2:00:00:00, SA = bridge MAC */
	f[0] = 0x01; f[1] = 0x80; f[2] = 0xc2; f[3] = f[4] = f[5] = 0x00;
	memcpy(f + 6, uip_ethaddr.addr, 6);
	/* RTL tag: directed TX, no L2 learning */
	f[12] = RTL_FRAME_TAG_ID >> 8; f[13] = RTL_FRAME_TAG_ID & 0xff;
	f[14] = RTL_FRAME_TAG_VERSION; f[15] = 0x00;
	f[16] = 0x00; f[17] = 0x20;
	f[18] = (((uint16_t)1 << port) >> 8) & 0xff;
	f[19] = ((uint16_t)1 << port) & 0xff;

	body = type == RSTP_BPDU_TCN ? 4 : (is_rst ? 36 : 35);
	f[TX_LEN] = 0; f[TX_LEN + 1] = 3 + body;
	f[22] = 0x42; f[23] = 0x42; f[24] = 0x03;	/* LLC */
	f[25] = 0x00; f[26] = 0x00;			/* protocol id */
	f[27] = is_rst ? 0x02 : 0x00;			/* version */
	f[28] = type;

	if (type == RSTP_BPDU_TCN) {
		uip_len = 29;
	} else {
		f[29] = rstp_tx_flags;
		memcpy(f + 30, rstp_tx_vec, RSTP_VEC_LEN); /* root/cost/bridge/port */
		/* times, 1/256 s units: age, max age 20, hello 2, fwd 15.
		 * age: 0 as root, one hop otherwise (see rstp.c notes) */
		f[52] = rstp_root_port == 0xff ? 0 : 1; f[53] = 0;
		f[54] = 20; f[55] = 0;
		f[56] = 2;  f[57] = 0;
		f[58] = 15; f[59] = 0;
		if (is_rst) {
			f[60] = 0;	/* version 1 length */
			uip_len = 61;
		} else {
			uip_len = 60;
		}
	}
	/* BPDUs are untagged link-local frames: keep tcpip_output() from
	 * inserting the management-VLAN 802.1Q tag.  And a port held in
	 * hardware state 00 blocks CPU-injected frames too, so lift it
	 * to the leaky listening state (01) just for this transmit -
	 * designated ports must send hellos/proposals WHILE discarding
	 * or two of these switches can never elect roles between
	 * themselves (deaf-and-mute oscillation). */
	static __xdata uint8_t lifted;
	lifted = 0;
	if (rstp_ports[port].state != RSTP_S_FORWARDING
	    && rstp_ports[port].link) {
		mstp_write(port, 0b01);
		lifted = 1;
	}
	saved_mgmt_vlan = management_vlan;
	management_vlan = 0;
	tcpip_output();
	management_vlan = saved_mgmt_vlan;
	if (lifted)
		mstp_write(port, 0b00);
	uip_len = 0;
}

/* ------------------------------------------------------------------ */
/* inputs into the core                                                */
/* ------------------------------------------------------------------ */

/* Called from the main loop for frames to 01:80:c2:00:00:00 */
void stp_in(void) __banked
{
	static __xdata uint8_t port;
	port = uip_buf[RX_PORT_NIBBLE] & 0x0f;

	/* consumed either way; TX happens via rstp_platform_tx directly */
	uip_len = 0;

	if (!(uip_buf[RX_LLC] == 0x42 && uip_buf[RX_LLC + 1] == 0x42
	      && uip_buf[RX_LLC + 2] == 0x03))
		return;
	if (uip_buf[RX_LLC + 3] || uip_buf[RX_LLC + 4])	/* protocol id */
		return;

	rstp_bpdu_in.type = uip_buf[RX_LLC + 6];
	if (rstp_bpdu_in.type == RSTP_BPDU_TCN) {
		rstp_bpdu_in.flags = 0;
	} else if (rstp_bpdu_in.type == RSTP_BPDU_CONFIG
		   || rstp_bpdu_in.type == RSTP_BPDU_RST) {
		rstp_bpdu_in.flags = uip_buf[RX_LLC + 7];
		memcpy(rstp_bpdu_in.vec, &uip_buf[RX_LLC + 8], RSTP_VEC_LEN);
	} else {
		return;
	}
#ifdef DEBUG
	print_string("BPDU port "); print_byte(port);
	print_string(" type "); print_byte(rstp_bpdu_in.type);
	print_string(" flags "); print_byte(rstp_bpdu_in.flags); write_char('\n');
#endif
	rstp_rx(port);
}

/* poll link state + speed for all ports, feed changes to the core */
static void poll_links(void)
{
	static __xdata uint8_t sts, sts8, speeds[4], speeds8;

	reg_read_m(RTL837X_REG_LINKS_STS);
	sts = sfr_data[1];		/* ports 0-7, one bit each */
	sts8 = sfr_data[2] & 1;		/* port 8 */
	reg_read_m(RTL837X_REG_LINKS);
	speeds[0] = sfr_data[0]; speeds[1] = sfr_data[1];
	speeds[2] = sfr_data[2]; speeds[3] = sfr_data[3];
	reg_read_m(RTL837X_REG_LINKS_89);
	speeds8 = sfr_data[3];

	static __xdata uint8_t up, nib, p;
	for (p = 0; p <= machine.max_port; p++) {
		up = p < 8 ? (sts >> p) & 1 : sts8;
		if (!up) {
			rstp_link(p, 0);
			continue;
		}
		nib = p < 8 ? speeds[3 - (p >> 1)] : speeds8;
		nib = (p & 1) ? (nib >> 4) : (nib & 0x0f);
		rstp_link(p, RSTP_LINK_UP | speed_class_map[nib & 0x7]);
	}
}

/* Called from the main loop (rate-divided); paces the 500 ms protocol
 * tick off the system tick counter instead of loop iterations */
void stp_timers(void) __banked
{
	static __xdata uint16_t now;
	now = (uint16_t)ticks;

	if ((uint16_t)(now - last_tick16) < SYS_TICK_HZ / 2)
		return;
	last_tick16 += SYS_TICK_HZ / 2;
	poll_links();
	rstp_tick500();
}

/* ------------------------------------------------------------------ */
/* CLI entry points                                                    */
/* ------------------------------------------------------------------ */

void stp_setup(void) __banked
{
	print_string("Enabling RSTP, bridge priority ");
	if (!stp_bridge_prio)
		stp_bridge_prio = 0x8000;
	print_short(stp_bridge_prio); write_char('\n');

	/* start with every data port discarding (00 - see
	 * rstp_platform_state), CPU port forwarding */
	sfr_data[0] = sfr_data[2] = sfr_data[3] = 0;
	sfr_data[1] = 0x0c;
	reg_write_m(RTL837X_MSTP_STATES);

	rstp_bridge_id[0] = stp_bridge_prio >> 8;
	rstp_bridge_id[1] = stp_bridge_prio & 0xff;
	memcpy(rstp_bridge_id + 2, uip_ethaddr.addr, 6);
	rstp_nports = machine.max_port + 1;
	rstp_init();
	last_tick16 = (uint16_t)ticks;
	poll_links();	/* feed current link state right away */
}

void stp_off(void) __banked
{
	/* everything forwarding, protocol out of the way */
	sfr_data[0] = sfr_data[2] = sfr_data[3] = 0;
	sfr_data[1] = 0x0c;
	for (uint8_t i = machine.min_port; i <= machine.max_port; i++)
		sfr_data[3 - (i >> 2)] |= 0b11 << ((i << 1) & 0x7);
	reg_write_m(RTL837X_MSTP_STATES);
}

static void print_id(__xdata uint8_t *id)
{
	print_byte(id[0]); print_byte(id[1]); write_char('.');
	for (uint8_t i = 2; i < 8; i++)
		print_byte(id[i]);
}

void stp_status(void) __banked
{
	static const char roles[5] = {'-', 'R', 'D', 'A', 'B'};
	static const char states[3] = {'d', 'l', 'F'};

	if (!stpEnabled) {
		print_string("Disabled\n");
		return;
	}
	print_string("Bridge "); print_id(rstp_bridge_id);
	print_string("\nRoot   "); print_id(rstp_root_vec);
	if (rstp_root_port == 0xff) {
		print_string(" (this bridge)\n");
	} else {
		print_string(" via port ");
		print_byte(machine.log_to_phys_port[rstp_root_port]);
		write_char('\n');
	}
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t p;
	for (p = machine.min_port; p <= machine.max_port; p++) {
		o = &rstp_ports[p];
		print_string("Port ");
		print_byte(machine.log_to_phys_port[p]);
		print_string(": ");
		if (!o->link) {
			print_string("down\n");
			continue;
		}
		/* role Root/Designated/Alternate/Backup,
		 * state discarding/learning/Forwarding; edge=<admin mode>,
		 * trailing * when the port currently operates as edge */
		write_char(roles[o->role]); write_char(' ');
		write_char(states[o->state]);
		print_string(" edge=");
		print_string(o->admin_edge == RSTP_EDGE_ON ? "on"
			: o->admin_edge == RSTP_EDGE_OFF ? "off" : "auto");
		if (o->oper_edge)
			write_char('*');
		if (!o->send_rstp)
			print_string(" stp-peer");
		write_char('\n');
	}
}
