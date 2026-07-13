/*
 * Host-side unit tests for the portable RSTP core (rstp.c).
 * Build:  gcc -I.. -Wall -o output/rstp_test rstp_test.c
 * The core is compiled in directly; the platform callbacks below record
 * state changes and transmitted BPDUs for the assertions.
 * This code is in the Public Domain
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../rstp.c"

/* ---- platform stubs ---------------------------------------------- */
static uint8_t hw_state[RSTP_MAX_PORTS];
static int flush_count;
struct txrec {
	uint8_t port, type, flags;
	uint8_t vec[RSTP_VEC_LEN];
};
static struct txrec txlog[64];
static int txn;

void rstp_platform_state(uint8_t port, uint8_t state) { hw_state[port] = state; }
void rstp_platform_flush(void) { flush_count++; }
void rstp_platform_tx(uint8_t port, uint8_t type, uint8_t flags, uint8_t *vec)
{
	if (txn < 64) {
		txlog[txn].port = port;
		txlog[txn].type = type;
		txlog[txn].flags = flags;
		memcpy(txlog[txn].vec, vec, RSTP_VEC_LEN);
		txn++;
	}
}

/* ---- helpers ------------------------------------------------------ */
static int fails, checks;
#define CHECK(cond, msg) do { checks++; if (!(cond)) { fails++; \
	printf("FAIL %s:%d  %s\n", __func__, __LINE__, msg); } } while (0)

static uint8_t MAC_SELF[6] = {0x1c, 0x2a, 0xa3, 0x24, 0x24, 0x4f};
static uint8_t MAC_ROOT[6] = {0x00, 0x00, 0x11, 0x11, 0x11, 0x11};
static uint8_t MAC_PEER[6] = {0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x01};

static void mkvec(uint8_t *vec, uint16_t rprio, const uint8_t *rmac,
		  uint32_t cost, uint16_t bprio, const uint8_t *bmac,
		  uint16_t portid)
{
	vec[0] = rprio >> 8; vec[1] = rprio & 0xff;
	memcpy(vec + 2, rmac, 6);
	vec[8] = cost >> 24; vec[9] = cost >> 16;
	vec[10] = cost >> 8; vec[11] = cost;
	vec[12] = bprio >> 8; vec[13] = bprio & 0xff;
	memcpy(vec + 14, bmac, 6);
	vec[20] = portid >> 8; vec[21] = portid & 0xff;
}

static void rx(uint8_t port, uint8_t type, uint8_t flags, uint8_t *vec)
{
	static struct rstp_bpdu b;
	b.type = type;
	b.flags = flags;
	if (vec)
		memcpy(b.vec, vec, RSTP_VEC_LEN);
	rstp_rx(port, &b);
}

static void ticks_n(int n) { while (n--) rstp_tick500(); }

static void fresh(void)
{
	memset(rstp_ports, 0, sizeof(rstp_ports));
	memset(hw_state, 0, sizeof(hw_state));
	flush_count = txn = 0;
	rstp_init(9, MAC_SELF, 0x8000);
}

static int sent(uint8_t port, uint8_t type, uint8_t flags_all, int since)
{
	for (int i = since; i < txn; i++)
		if (txlog[i].port == port && txlog[i].type == type
		    && (txlog[i].flags & flags_all) == flags_all)
			return 1;
	return 0;
}

/* ---- tests --------------------------------------------------------- */

/* no peers, admin edge off: staged forward-delay transitions */
static void t_slow_transitions(void)
{
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	CHECK(rstp_ports[0].role == RSTP_R_DESIGNATED, "designated");
	CHECK(hw_state[0] == RSTP_S_DISCARDING, "starts discarding");
	ticks_n(T_FWD_DELAY);
	CHECK(hw_state[0] == RSTP_S_LEARNING, "learning after fwd delay");
	ticks_n(T_FWD_DELAY);
	CHECK(hw_state[0] == RSTP_S_FORWARDING, "forwarding after 2x");
	CHECK(flush_count > 0, "TC flush on non-edge forward");
}

/* auto edge: silence -> edge forwarding, no TC */
static void t_auto_edge(void)
{
	fresh();
	rstp_link(0, 1, 2);
	CHECK(hw_state[0] == RSTP_S_DISCARDING, "starts discarding");
	ticks_n(T_EDGE);
	CHECK(rstp_ports[0].oper_edge == 1, "auto edge set");
	CHECK(hw_state[0] == RSTP_S_FORWARDING, "edge forwards");
	CHECK(flush_count == 0, "edge forward is not a TC");
	/* a BPDU cancels edge and knocks it back to discarding */
	uint8_t v[RSTP_VEC_LEN];
	mkvec(v, 0x9000, MAC_PEER, 0, 0x9000, MAC_PEER, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	CHECK(rstp_ports[0].oper_edge == 0, "BPDU clears edge");
	CHECK(hw_state[0] == RSTP_S_DISCARDING, "back to discarding");
}

/* superior BPDU: root election, relay downstream */
static void t_root_election(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);	/* 1G: cost 20000 */
	rstp_link(1, 1, 2);
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x1000, MAC_ROOT, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG | RSTP_F_LEARNING | RSTP_F_FORWARDING, v);
	CHECK(rstp_ports[0].role == RSTP_R_ROOT, "port 0 is root port");
	CHECK(rstp_root_port == 0, "root port recorded");
	CHECK(memcmp(rstp_root_vec + 2, MAC_ROOT, 6) == 0, "root id adopted");
	/* our cost = root's 0 + our port cost 20000 */
	CHECK(rstp_root_vec[V_COST + 2] == 0x4e && rstp_root_vec[V_COST + 3] == 0x20,
	      "root path cost added");
	CHECK(rstp_ports[1].role == RSTP_R_DESIGNATED, "port 1 designated");
	CHECK(memcmp(rstp_ports[1].vec + 2, MAC_ROOT, 6) == 0, "relaying root id");
	int before = txn;
	ticks_n(T_HELLO);
	CHECK(sent(1, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, before), "hello on designated");
}

/* proposal -> sync -> agreement -> rapid root forwarding */
static void t_proposal_agreement(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	rstp_link(1, 1, 2);
	/* get port 1 forwarding first (it must be cut by sync) */
	ticks_n(2 * T_FWD_DELAY);
	CHECK(hw_state[1] == RSTP_S_FORWARDING, "port 1 forwarding");
	int before = txn;
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x1000, MAC_ROOT, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG | RSTP_F_PROPOSAL, v);
	CHECK(rstp_ports[0].role == RSTP_R_ROOT, "root via proposal");
	CHECK(hw_state[0] == RSTP_S_FORWARDING, "root forwards rapidly");
	CHECK(hw_state[1] == RSTP_S_DISCARDING, "designated synced (cut)");
	CHECK(sent(0, RSTP_BPDU_RST, RSTP_F_ROLE_ROOT | RSTP_F_AGREEMENT, before),
	      "agreement sent");
	/* downstream peer agrees to port 1's proposal -> rapid forward */
	before = txn;
	mkvec(v, 0x1000, MAC_ROOT, 20000, 0x8000, MAC_SELF, 0x8002);
	rx(1, RSTP_BPDU_RST, RSTP_F_ROLE_ROOT | RSTP_F_AGREEMENT, v);
	CHECK(hw_state[1] == RSTP_S_FORWARDING, "agreement forwards designated");
}

/* alternate port: redundant path blocked, promoted on failure */
static void t_alternate_promotion(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	rstp_link(1, 1, 2);
	/* root reachable via both ports; port 0 cheaper sender */
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x1000, MAC_ROOT, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x7000, MAC_PEER, 0x8005);
	rx(1, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	CHECK(rstp_ports[0].role == RSTP_R_ROOT, "port 0 root");
	CHECK(rstp_ports[1].role == RSTP_R_ALTERNATE, "port 1 alternate");
	CHECK(hw_state[1] == RSTP_S_DISCARDING, "alternate discarding");
	/* root port dies: alternate promotes rapidly */
	rstp_link(0, 0, 0);
	CHECK(rstp_ports[1].role == RSTP_R_ROOT, "alternate promoted");
	CHECK(hw_state[1] == RSTP_S_FORWARDING, "promoted port forwards");
}

/* backup: hearing our own BPDU back */
static void t_backup(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	rstp_link(1, 1, 2);
	/* port 1 hears port 0's own advertisement (hub between them) */
	mkvec(v, 0x8000, MAC_SELF, 0, 0x8000, MAC_SELF, 0x8001);
	rx(1, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	CHECK(rstp_ports[1].role == RSTP_R_BACKUP, "backup role");
	CHECK(hw_state[1] == RSTP_S_DISCARDING, "backup discarding");
}

/* inferior info on a designated port is answered immediately */
static void t_inferior_reply(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	int before = txn;
	mkvec(v, 0xf000, MAC_PEER, 999999, 0xf000, MAC_PEER, 0x8003);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	CHECK(rstp_ports[0].role == RSTP_R_DESIGNATED, "still designated");
	ticks_n(1);
	CHECK(sent(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, before),
	      "reply with better info");
}

/* info ageing: dead root -> take over */
static void t_ageing(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x1000, MAC_ROOT, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG, v);
	CHECK(rstp_ports[0].role == RSTP_R_ROOT, "root elected");
	ticks_n(T_INFO_AGE + 1);	/* silence */
	CHECK(rstp_root_port == 0xff, "we are root again");
	CHECK(rstp_ports[0].role == RSTP_R_DESIGNATED, "port designated again");
}

/* topology change propagation + flag */
static void t_tc(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	rstp_link(1, 1, 2);
	ticks_n(2 * T_FWD_DELAY);	/* both forwarding */
	flush_count = 0;
	int before = txn;
	mkvec(v, 0x9000, MAC_PEER, 0, 0x9000, MAC_PEER, 0x8001);
	rx(0, RSTP_BPDU_RST, RSTP_F_ROLE_DESIG | RSTP_F_TC, v);
	CHECK(flush_count > 0, "TC flushes L2");
	ticks_n(1);
	CHECK(sent(1, RSTP_BPDU_RST, RSTP_F_TC, before), "TC propagated");
}

/* STP (802.1D) peer: fall back to config BPDUs, TCN handling */
static void t_stp_compat(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	ticks_n(T_MIGRATE + 1);		/* migration delay over */
	mkvec(v, 0x9000, MAC_PEER, 0, 0x9000, MAC_PEER, 0x8001);
	rx(0, RSTP_BPDU_CONFIG, 0, v);
	CHECK(rstp_ports[0].send_rstp == 0, "STP peer detected");
	int before = txn;
	ticks_n(T_HELLO);
	CHECK(sent(0, RSTP_BPDU_CONFIG, 0, before), "sends config BPDUs");
	/* downstream STP bridge reports a topology change */
	before = txn;
	rx(0, RSTP_BPDU_TCN, 0, NULL);
	ticks_n(1);
	CHECK(sent(0, RSTP_BPDU_CONFIG, RSTP_F_TCACK, before), "TCN acked");
}

/* TCN owed upstream when the root port peer is classic STP */
static void t_tcn_upstream(void)
{
	uint8_t v[RSTP_VEC_LEN];
	fresh();
	rstp_ports[0].admin_edge = RSTP_EDGE_OFF;
	rstp_ports[1].admin_edge = RSTP_EDGE_OFF;
	rstp_link(0, 1, 2);
	rstp_link(1, 1, 2);
	ticks_n(T_MIGRATE + 1);
	/* STP root upstream on port 0 */
	mkvec(v, 0x1000, MAC_ROOT, 0, 0x1000, MAC_ROOT, 0x8001);
	rx(0, RSTP_BPDU_CONFIG, 0, v);
	CHECK(rstp_ports[0].role == RSTP_R_ROOT, "root via STP peer");
	CHECK(rstp_ports[0].send_rstp == 0, "compat mode on root port");
	/* a local TC (port 1 reaches forwarding) must produce a TCN;
	 * keep the root's info alive with periodic hellos meanwhile */
	int before = txn;
	for (int i = 0; i < 2 * T_FWD_DELAY + T_HELLO + 1; i++) {
		if (!(i % T_HELLO))
			rx(0, RSTP_BPDU_CONFIG, 0, v);
		rstp_tick500();
	}
	CHECK(sent(0, RSTP_BPDU_TCN, 0, before), "TCN sent upstream");
	/* TCA stops it */
	rx(0, RSTP_BPDU_CONFIG, RSTP_F_TCACK, v);
	CHECK(tcn_pending == 0, "TCA clears TCN");
}

int main(void)
{
	t_slow_transitions();
	t_auto_edge();
	t_root_election();
	t_proposal_agreement();
	t_alternate_promotion();
	t_backup();
	t_inferior_reply();
	t_ageing();
	t_tc();
	t_stp_compat();
	printf("t_tcn_upstream: ");
	t_tcn_upstream();
	printf("\n%d checks, %d failures\n", checks, fails);
	return fails ? 1 : 0;
}
