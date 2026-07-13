/*
 * Portable RSTP (802.1w) core — single spanning tree, pragmatic subset:
 * full priority-vector comparison, root/designated/alternate/backup role
 * election, rapid transitions via proposal/agreement and via alternate
 * promotion, edge ports (admin on/off + auto with 3 s BPDU silence),
 * topology-change propagation with L2 flush, and STP (802.1D) peer
 * compatibility including TCN/TCA on the root port.
 *
 * Everything protocol-visible is kept big-endian so vector comparison is
 * a single byte loop.  Timers run in 500 ms units off rstp_tick500().
 * This code is in the Public Domain
 */
#include <stdint.h>
#include "rstp.h"

#ifdef __SDCC
#pragma codeseg BANK2
#endif

/* Tiny byte helpers.  The project's memcpy/memset declarations clash
 * with the SDCC libc ones, and every byte of function parameters lands
 * in the (exhausted) 128-byte internal RAM, so the mutating helpers
 * take their operands via __xdata staging globals and macros. */
static __xdata uint8_t * __xdata bp_d;
static __xdata uint8_t * __xdata bp_s;
static __xdata uint8_t bp_n, bp_v;

static void bcopy_(void)
{
	while (bp_n--)
		*bp_d++ = *bp_s++;
}

static void bset_(void)
{
	while (bp_n--)
		*bp_d++ = bp_v;
}

static int8_t bcmp_(void)
{
	while (bp_n--) {
		if (*bp_d != *bp_s)
			return *bp_d < *bp_s ? -1 : 1;
		bp_d++; bp_s++;
	}
	return 0;
}

#define BCOPY(d, s, n) do { bp_d = (d); bp_s = (s); bp_n = (n); bcopy_(); } while (0)
#define BSET(d, v, n)  do { bp_d = (d); bp_v = (v); bp_n = (n); bset_(); } while (0)
#define COSTADD(d, s)  do { bp_d = (d); bp_s = (s); cost_add_(); } while (0)
/* comma expression: usable inline in conditions */
#define BCMP(a, b, n)  (bp_d = (a), bp_s = (b), bp_n = (n), bcmp_())

__xdata struct rstp_port rstp_ports[RSTP_MAX_PORTS];
__xdata uint8_t rstp_bridge_id[8];
__xdata uint8_t rstp_nports;
__xdata uint8_t rstp_root_vec[RSTP_VEC_LEN];
__xdata uint8_t rstp_root_port;
__xdata struct rstp_bpdu rstp_bpdu_in;
__xdata uint8_t rstp_tx_type;
__xdata uint8_t rstp_tx_flags;
__xdata uint8_t rstp_tx_vec[RSTP_VEC_LEN];
static __xdata uint8_t tcn_pending;	/* STP-compat: TCN owed on root port */

/* timer values, 500 ms units */
#define T_HELLO		4	/* 2 s */
#define T_FWD_DELAY	30	/* 15 s */
#define T_INFO_AGE	12	/* 3 x hello */
#define T_MIGRATE	6	/* 3 s */
#define T_TC		6	/* hello + 1 s */
#define T_EDGE		6	/* 3 s of BPDU silence -> auto edge */

/* 802.1t path costs by speed class 0..5 = 10M 100M 1G 2.5G 5G 10G */
/* in __xdata (not __code) so the byte helpers can point at it */
static __xdata uint8_t path_cost[6][4] = {
	{0x00, 0x1e, 0x84, 0x80},	/* 10M   2,000,000 */
	{0x00, 0x03, 0x0d, 0x40},	/* 100M    200,000 */
	{0x00, 0x00, 0x4e, 0x20},	/* 1G       20,000 */
	{0x00, 0x00, 0x1f, 0x40},	/* 2.5G      8,000 */
	{0x00, 0x00, 0x0f, 0xa0},	/* 5G        4,000 */
	{0x00, 0x00, 0x07, 0xd0},	/* 10G       2,000 */
};

/* bp_d[0..3] += bp_s[0..3], both big-endian 32 bit (use COSTADD) */
static void cost_add_(void)
{
	uint16_t s = 0;
	for (int8_t i = 3; i >= 0; i--) {
		s += (uint16_t)bp_d[i] + bp_s[i];
		bp_d[i] = s & 0xff;
		s >>= 8;
	}
}

/* the vector this bridge advertises on port p, left in ov[]:
 * {elected root, our root path cost, our bridge id, our port id} */
static __xdata uint8_t ov[RSTP_VEC_LEN];

static void own_vec(uint8_t p)
{
	BCOPY(ov, rstp_root_vec, 12);		/* root id + cost */
	BCOPY(ov + V_BRIDGE, rstp_bridge_id, 8);
	ov[V_PORT] = 0x80;
	ov[V_PORT + 1] = p + 1;
}

static void set_state(uint8_t p, uint8_t st)
{
	if (rstp_ports[p].state == st)
		return;
	rstp_ports[p].state = st;
	rstp_platform_state(p, st);
}

/* topology change: flush and start TC on every other active non-edge port */
static void tc_detected(uint8_t p)
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t i;
	rstp_platform_flush();
	for (i = 0; i < rstp_nports; i++) {
		o = &rstp_ports[i];
		if (i == p || !o->link || o->oper_edge)
			continue;
		if (o->role == RSTP_R_ROOT || o->role == RSTP_R_DESIGNATED) {
			o->tc_while = T_TC;
			o->new_info = 1;
			if (o->role == RSTP_R_ROOT && !o->send_rstp)
				tcn_pending = 1;
		}
	}
}

/* a non-edge port reached forwarding */
static void fwd_transition(uint8_t p)
{
	set_state(p, RSTP_S_FORWARDING);
	if (!rstp_ports[p].oper_edge)
		tc_detected(p);
}

/* "sync": before rapidly forwarding a (new) root port, make sure no other
 * non-edge designated port is forwarding without an agreement from its
 * downstream peer */
static void sync_others(uint8_t except)
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t i;
	for (i = 0; i < rstp_nports; i++) {
		o = &rstp_ports[i];
		if (i == except || !o->link || o->oper_edge)
			continue;
		if (o->role == RSTP_R_DESIGNATED && !o->agreed
		    && o->state != RSTP_S_DISCARDING) {
			set_state(i, RSTP_S_DISCARDING);
			o->fd_while = T_FWD_DELAY;
			o->new_info = 1;	/* re-propose */
		}
	}
}

static void tx_port(uint8_t p);

/* recompute root, roles and states for the whole bridge */
static void reelect(void)
{
	__xdata static uint8_t cand[RSTP_VEC_LEN];
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t old_root_port;
	static __xdata uint8_t new_role;
	static __xdata uint8_t p;
	old_root_port = rstp_root_port;

	/* our own bridge vector: we are root */
	BCOPY(rstp_root_vec, rstp_bridge_id, 8);
	BSET(rstp_root_vec + V_COST, 0, 4);
	BCOPY(rstp_root_vec + V_BRIDGE, rstp_bridge_id, 8);
	rstp_root_vec[V_PORT] = rstp_root_vec[V_PORT + 1] = 0;
	rstp_root_port = 0xff;

	/* best root path via any port with live info from another bridge */
	for (p = 0; p < rstp_nports; p++) {
		o = &rstp_ports[p];
		if (!o->link || !o->rcvd_info_while)
			continue;
		if (!BCMP(o->vec + V_BRIDGE, rstp_bridge_id, 8))
			continue;	/* our own BPDU looped back */
		BCOPY(cand, o->vec, RSTP_VEC_LEN);
		COSTADD(cand + V_COST, o->cost);
		if (BCMP(cand, rstp_root_vec, RSTP_VEC_LEN) < 0) {
			BCOPY(rstp_root_vec, cand, RSTP_VEC_LEN);
			rstp_root_port = p;
		}
	}

	for (p = 0; p < rstp_nports; p++) {
		o = &rstp_ports[p];
		if (!o->link) {
			o->role = RSTP_R_DISABLED;
			continue;
		}
		if (p == rstp_root_port) {
			new_role = RSTP_R_ROOT;
		} else {
			own_vec(p);
			if (o->rcvd_info_while
			    && BCMP(o->vec, ov, RSTP_VEC_LEN) < 0)
				new_role = BCMP(o->vec + V_BRIDGE,
						 rstp_bridge_id, 8)
					   ? RSTP_R_ALTERNATE : RSTP_R_BACKUP;
			else
				new_role = RSTP_R_DESIGNATED;
		}

		if (new_role == RSTP_R_DESIGNATED) {
			/* we own this segment: our info replaces held info */
			own_vec(p);
			if (BCMP(o->vec, ov, RSTP_VEC_LEN)) {
				BCOPY(o->vec, ov, RSTP_VEC_LEN);
				o->new_info = 1;
				o->agreed = 0;
			}
			if (o->role != RSTP_R_DESIGNATED) {
				/* fresh designated port starts discarding
				 * unless edge or already agreed */
				if (!o->oper_edge && !o->agreed) {
					set_state(p, RSTP_S_DISCARDING);
					o->fd_while = T_FWD_DELAY;
				} else {
					fwd_transition(p);
				}
				o->new_info = 1;
			} else if (o->oper_edge
				   && o->state != RSTP_S_FORWARDING) {
				fwd_transition(p);
			}
		} else if (new_role == RSTP_R_ALTERNATE
			   || new_role == RSTP_R_BACKUP) {
			set_state(p, RSTP_S_DISCARDING);
			o->fd_while = 0;
		} else if (new_role == RSTP_R_ROOT) {
			if (o->role == RSTP_R_ALTERNATE
			    || p != old_root_port) {
				/* new root port: sync, then rapid forward
				 * (an alternate was already excluded from
				 * the tree, promoting it cannot loop) */
				sync_others(p);
				fwd_transition(p);
			}
		}
		o->role = new_role;
	}

	/* answer an outstanding proposal on the root port: sync, forward,
	 * and send the agreement immediately (this is the rapid wave) */
	if (rstp_root_port != 0xff) {
		o = &rstp_ports[rstp_root_port];
		if (o->proposed) {
			o->proposed = 0;
			sync_others(rstp_root_port);
			if (o->state != RSTP_S_FORWARDING)
				fwd_transition(rstp_root_port);
			o->new_info = 2;	/* 2: agreement flag */
			tx_port(rstp_root_port);
			o->new_info = 0;
			o->hello_when = T_HELLO;
		}
	}
}

/* build + hand one BPDU to the platform via the tx globals */
static void tx_port(uint8_t p)
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t flags;
	o = &rstp_ports[p];
	flags = 0;

	BCOPY(rstp_tx_vec, o->vec, RSTP_VEC_LEN);

	if (o->role == RSTP_R_ROOT && !o->send_rstp) {
		/* STP-compat upstream: TC is signalled with a TCN */
		if (tcn_pending) {
			rstp_tx_type = RSTP_BPDU_TCN;
			rstp_tx_flags = 0;
			rstp_platform_tx(p);
		}
		return;
	}

	if (o->tc_while)
		flags |= RSTP_F_TC;

	if (!o->send_rstp) {
		/* plain 802.1D config BPDU */
		if (o->tc_ack) {
			flags |= RSTP_F_TCACK;
			o->tc_ack = 0;
		}
		rstp_tx_type = RSTP_BPDU_CONFIG;
		rstp_tx_flags = flags;
		rstp_platform_tx(p);
		return;
	}

	if (o->state == RSTP_S_LEARNING)
		flags |= RSTP_F_LEARNING;
	if (o->state == RSTP_S_FORWARDING)
		flags |= RSTP_F_LEARNING | RSTP_F_FORWARDING;

	if (o->role == RSTP_R_ROOT) {
		flags |= RSTP_F_ROLE_ROOT;
		if (o->new_info == 2)
			flags |= RSTP_F_AGREEMENT;
	} else {
		flags |= RSTP_F_ROLE_DESIG;
		if (o->state == RSTP_S_DISCARDING && !o->oper_edge
		    && !o->agreed)
			flags |= RSTP_F_PROPOSAL;
	}
	rstp_tx_type = RSTP_BPDU_RST;
	rstp_tx_flags = flags;
	rstp_platform_tx(p);
}

void rstp_init(void) __banked
{
	/* rstp_bridge_id and rstp_nports are filled in by the glue */
	if (rstp_nports > RSTP_MAX_PORTS)
		rstp_nports = RSTP_MAX_PORTS;
	tcn_pending = 0;
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t admin, p;
	for (p = 0; p < rstp_nports; p++) {
		o = &rstp_ports[p];
		admin = o->admin_edge;	/* survives re-init */
		BSET((__xdata uint8_t *)o, 0, sizeof(*o));
		o->admin_edge = admin;
		o->role = RSTP_R_DISABLED;
		o->state = RSTP_S_DISCARDING;
		o->send_rstp = 1;
	}
	reelect();
}

void rstp_link(uint8_t port, uint8_t up_speed) __banked
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t up, speed_class;
	o = &rstp_ports[port];
	up = up_speed & RSTP_LINK_UP;
	speed_class = up_speed & 0x07;
	if (port >= rstp_nports)
		return;
	if (up && o->link) {
		/* speed change without a flap: only the path cost moves */
		if (BCMP(o->cost, path_cost[speed_class > 5 ? 5 : speed_class], 4)) {
			BCOPY(o->cost, path_cost[speed_class > 5 ? 5 : speed_class], 4);
			reelect();
		}
		return;
	}
	if (!up && !o->link)
		return;
	o->link = up ? 1 : 0;
	o->rcvd_info_while = 0;
	o->proposed = o->agreed = o->rcvd_bpdu = 0;
	o->tc_while = o->tc_ack = o->new_info = 0;
	o->send_rstp = 1;
	o->oper_edge = 0;
	set_state(port, RSTP_S_DISCARDING);
	if (up) {
		BCOPY(o->cost, path_cost[speed_class > 5 ? 5 : speed_class], 4);
		o->mdelay_while = T_MIGRATE;
		o->hello_when = 1;	/* BPDU on the next tick */
		if (o->admin_edge == RSTP_EDGE_ON)
			o->oper_edge = 1;
		else if (o->admin_edge == RSTP_EDGE_AUTO)
			o->edge_delay = T_EDGE;
	}
	reelect();
}

void rstp_set_edge(uint8_t port, uint8_t mode) __banked
{
	static __xdata struct rstp_port * __xdata o;
	o = &rstp_ports[port];
	if (port >= rstp_nports)
		return;
	o->admin_edge = mode;
	if (mode == RSTP_EDGE_ON)
		o->oper_edge = 1;
	else if (mode == RSTP_EDGE_OFF)
		o->oper_edge = 0;
	else if (!o->rcvd_bpdu && o->link)
		o->edge_delay = T_EDGE;
	reelect();
}

void rstp_rx(uint8_t port) __banked
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata struct rstp_bpdu * __xdata b;
	static __xdata uint8_t role;
	o = &rstp_ports[port];
	b = &rstp_bpdu_in;

	if (port >= rstp_nports || !o->link)
		return;

	o->rcvd_bpdu = 1;
	o->edge_delay = 0;
	if (o->oper_edge) {
		/* an edge port that hears a bridge is not an edge port */
		o->oper_edge = 0;
		if (o->state == RSTP_S_FORWARDING) {
			set_state(port, RSTP_S_DISCARDING);
			o->fd_while = T_FWD_DELAY;
		}
	}

	if (b->type == RSTP_BPDU_TCN) {
		o->send_rstp = 0;
		o->tc_ack = 1;
		o->new_info = 1;
		tc_detected(port);
		return;
	}

	/* protocol migration */
	if (!o->mdelay_while) {
		if (b->type == RSTP_BPDU_CONFIG && o->send_rstp) {
			o->send_rstp = 0;
			o->mdelay_while = T_MIGRATE;
			o->new_info = 1;
		} else if (b->type == RSTP_BPDU_RST && !o->send_rstp) {
			o->send_rstp = 1;
			o->mdelay_while = T_MIGRATE;
			o->new_info = 1;
		}
	}

	role = b->type == RSTP_BPDU_RST ? (b->flags & RSTP_F_ROLE_MASK)
					: RSTP_F_ROLE_DESIG;

	/* agreement from the downstream root port: rapid forward */
	if (b->type == RSTP_BPDU_RST && (b->flags & RSTP_F_AGREEMENT)
	    && role == RSTP_F_ROLE_ROOT && o->role == RSTP_R_DESIGNATED) {
		o->agreed = 1;
		if (o->state != RSTP_S_FORWARDING)
			fwd_transition(port);
	}

	if (role == RSTP_F_ROLE_DESIG) {
		static __xdata int8_t c;
		static __xdata uint8_t same_sender;
		c = BCMP(b->vec, o->vec, RSTP_VEC_LEN);
		same_sender = !BCMP(b->vec + V_BRIDGE,
				    o->vec + V_BRIDGE, 10);
		if (c < 0 || (same_sender && c)) {
			/* superior (or changed info from the same
			 * designated bridge+port): adopt it */
			BCOPY(o->vec, b->vec, RSTP_VEC_LEN);
			o->rcvd_info_while = T_INFO_AGE;
			o->proposed = (b->flags & RSTP_F_PROPOSAL) ? 1 : 0;
			o->agreed = 0;
			reelect();
		} else if (!c) {
			o->rcvd_info_while = T_INFO_AGE;
			if ((b->flags & RSTP_F_PROPOSAL)
			    && o->role == RSTP_R_ROOT) {
				o->proposed = 1;
				reelect();
			}
		} else {
			/* inferior: if we are designated here, our next
			 * BPDU corrects the sender immediately */
			if (o->role == RSTP_R_DESIGNATED)
				o->new_info = 1;
		}
	}

	if (b->flags & RSTP_F_TC)
		tc_detected(port);
	if ((b->flags & RSTP_F_TCACK) && o->role == RSTP_R_ROOT)
		tcn_pending = 0;
}

void rstp_tick500(void) __banked
{
	static __xdata struct rstp_port * __xdata o;
	static __xdata uint8_t p;
	for (p = 0; p < rstp_nports; p++) {
		o = &rstp_ports[p];
		if (!o->link)
			continue;

		if (o->mdelay_while)
			o->mdelay_while--;
		if (o->tc_while)
			o->tc_while--;

		/* auto-edge: silence long enough -> edge, forward */
		if (o->edge_delay && !--o->edge_delay
		    && o->admin_edge == RSTP_EDGE_AUTO && !o->rcvd_bpdu) {
			o->oper_edge = 1;
			if (o->role == RSTP_R_DESIGNATED
			    && o->state != RSTP_S_FORWARDING)
				fwd_transition(p);
		}

		/* received info ageing (root/alternate/backup ports) */
		if (o->rcvd_info_while && !--o->rcvd_info_while) {
			o->proposed = 0;
			reelect();
		}

		/* slow path: forward-delay staged transitions */
		if (o->fd_while && !--o->fd_while
		    && o->role == RSTP_R_DESIGNATED && !o->agreed) {
			if (o->state == RSTP_S_DISCARDING) {
				set_state(p, RSTP_S_LEARNING);
				o->fd_while = T_FWD_DELAY;
			} else if (o->state == RSTP_S_LEARNING) {
				fwd_transition(p);
			}
		}

		/* hello / triggered transmission */
		if (o->hello_when)
			o->hello_when--;
		if (!o->hello_when || o->new_info) {
			if (o->role == RSTP_R_DESIGNATED
			    || (o->role == RSTP_R_ROOT
				&& (o->new_info || o->tc_while || tcn_pending)))
				tx_port(p);
			o->new_info = 0;
			o->hello_when = T_HELLO;
		}
	}
}
