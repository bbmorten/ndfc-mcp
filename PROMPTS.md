# Prompts for ndfc-mcp

Longer requests than the five in the README: each needs several tools and some reasoning across
their results. Copy one, change the fabric, switch and object names to yours, and send it.

There are two sets, and every prompt in both was run against Cisco's DevNet sandbox (NDFC
12.2.2.241, `DevNet_Fabric`: two spines, two leaves, one border) through the Claude Code CLI over
the stdio bridge, each in a new conversation with nothing but this server's tools:

- **[Read](#read-prompts)**: thirteen questions that change nothing. Run on 2026-11-12 with the
  twelve read tools of that day: 205 turns, 720 s in all.
- **[Write](#write-prompts)**: nineteen prompts in six scenarios that create, attach, deploy,
  detach and delete VRFs and networks. Run on 2026-11-14 with 0.3.1 and
  `NDFC_MCP_ACCESS=write`: 223 turns, 868 s in all. They need write access, and they configure
  switches.

Both sets, with the full answers, are knowledge-base articles 23 and 24 of the GPU Pool platform
site (`ai-resource-sched`, `site/src/content/kb/en/ndfc-on-your-own-key.md` and
`ndfc-write-from-aimo.md`). Each note below says what a prompt took (a *turn* is one tool call or
one piece of the answer) and what it found on the lab; your fabric will answer differently.

## Read prompts

### What makes a question work here

- **Name the fabric or the switch.** Without one, the assistant spends its first calls finding
  out which exist.
- **Say what to compare.** "Audit the MTU" is vague; "the two ends of every fabric link, against
  the fabric's MTU setting" is a check.
- **Ask for what it could not check.** The server hides some things on purpose (configuration
  text, secrets). A good answer says which checks it could not make.
- **Ask it not to guess.** Lists are cut when they are long, and the alarm list is one page from
  the controller. "Do not report on ports you did not look at" keeps a partial answer honest.
- **Ask for a shape**: a table, a Mermaid diagram, an ordered checklist. It is easier to act on.

### 1. Reconstruct the topology

> Reconstruct the physical topology of DevNet_Fabric from the controller. Use the switch
> inventory for roles and the link list for connections. Give me: (1) a Mermaid `graph TD`
> diagram with one node per switch labelled "name (role)" and one edge per link labelled with
> both interface names; (2) a table of every leaf and border switch showing which spines it
> connects to; (3) anything that breaks a clean spine-leaf design: a leaf that does not reach
> every spine, a link the controller sees only as a discovered neighbour, a device that is cabled
> into the fabric but is not a member of it. Use only what the tools return, and say so if a
> result was truncated.

*6 turns, 39 s. It drew the diagram and found three things: a switch `leaf4` cabled to both
spines but in no fabric, a leaf-to-leaf link pair that is down, and the border's uplink to a
device in another fabric.*

### 2. Triage the alarms

> Triage the alarms the controller is raising for DevNet_Fabric. For each switch that has raised
> alarms, look at the interfaces the alarms name and at the fabric's links, then sort the alarms
> into three groups: (a) NOISE: the port is simply unused, down with nothing cabled and not part
> of any fabric link; (b) REAL: the port is one end of a fabric link, or carries an address, or
> was up and is now down; (c) CANNOT TELL from the data available. Give a count per group and per
> switch, list every alarm in group (b) with the evidence, and finish with the one thing I should
> look at first. Do not guess about ports you did not check.

*14 turns, 51 s. All 50 alarms it could see were unused ports on one spine. It also said, without
being asked, that the controller had returned exactly one page of 50, so "no alarms on the other
switches" was not something it could claim — and it pointed at the two down leaf-to-leaf links,
which had no alarm on that page.*

### 3. Investigate out-of-sync switches

> Find out which switches in DevNet_Fabric, if any, are out of sync with the controller. If none
> are, say so and stop here. Otherwise, for each: its role, its last five configuration deployments
> (what was deployed to, when, by whom, outcome, and whether any command failed), and whether its
> interfaces also show an out-of-sync state and which ones. Compare with one switch that IS in
> sync. Tell me what the out-of-sync switches have in common, what the data suggests changed, and
> what the tools cannot tell me (for example the pending configuration difference itself). End
> with a short, ordered checklist of what an engineer should do in the NDFC UI next. Do not
> propose that you make any change.

*20 turns, 85 s. Three switches (both leaves and the border) were out of sync, every one of their
64 Ethernet ports with them, while loopbacks and management were in sync and the spines were
clean. No deployment had failed. It said plainly that it could not see the pending difference.*

### 4. Audit the underlay addressing

> Audit the underlay addressing of DevNet_Fabric against the fabric's own settings. Read the
> fabric's loopback, subnet and MTU related settings, then for every switch in the fabric list
> its Loopback interfaces with their addresses and VRF, and the MTU of its fabric-facing Ethernet
> interfaces (the ones that are ends of fabric links). Report: a table of switch, role,
> Loopback0, Loopback1 (if present), and whether each address falls inside the range the fabric
> settings define; any duplicate address; any fabric link whose two ends have different MTU, or
> an MTU different from the fabric MTU setting. State clearly which checks passed, which failed,
> and which you could not perform and why.

*21 turns, 57 s. Every loopback was inside its range and no address was duplicated except the
anycast rendezvous-point address, which it recognised as intended. One failure: the border's
link to the external router had MTU 9216 on one end and 1500 on the other.*

### 5. Morning health brief

> Give me a morning brief for every fabric on this controller, one section per fabric: how many
> switches by role, how many are healthy and how many in sync, software versions in use and
> whether they are all the same, the raised alarms grouped by severity and by switch, and any
> configuration deployment that failed (use list_deploy_history with status FAILED; if there is
> none, say so). Put the three things that most need attention at the top, each with the switch
> name and the evidence. If the alarm list looks like a single page, say so instead of treating it
> as complete.

*23 turns, 52 s. Its top three: three switches out of sync with no failed deployment to explain
it, an alarm list that was one page of 50 (all from spine1) while every switch showed Minor
health, and spine1's 50 unacknowledged unused-port alarms. It also noticed that every timestamp
was about two years old.*

### 6. Is the fabric ready for a change?

> Tomorrow I will add a new tenant to DevNet_Fabric: one VRF and two networks. Check whether the
> fabric is in a state to take that change, and tell me what I need to know first. Look at:
> whether every switch is reachable and in sync, and which are not (if none, say so); raised
> alarms on the leaves and the border; the VRFs and networks that already exist, with their VNIs
> and VLANs; and the fabric's settings for VRF and network VLAN ranges, VNI ranges and the VRF and
> network templates. Give me a go / no-go with reasons, the ranges my new VNIs and VLANs must come
> from, and the values already taken. Do not create anything.

*19 turns, 49 s. No-go: the three switches that would get the tenant were out of sync, and it
could not see any alarm for them because the one page of alarms was all spine1. It gave the
ranges to take values from and said the rest would not stand in the way.*

### 7. Compare two switches that should be twins

> leaf1 and leaf2 in DevNet_Fabric are meant to be configured alike. Compare them. For the
> policies: which templates are applied to one and not the other, and which are applied to both
> a different number of times. For the interfaces: any port whose mode, MTU, allowed VLANs,
> admin state or policy differs between the two switches, by port name. Ignore differences that
> must exist (hostname, serial number, addresses, the far end of each uplink). Give me two short
> tables and one sentence saying whether I should worry.

*21 turns, 67 s. No difference: 136 policies on each, matched one by one and grouped by what
they are attached to, and no port differing in any of the five properties.*

### 8. Free ports for new servers

> I need to connect four new dual-homed servers in DevNet_Fabric. For every leaf, count the
> Ethernet ports that are free: admin up or down, operationally down, no neighbour discovered,
> no description, not a member of a port-channel and not an end of any fabric link. List the
> free ports per leaf with their current mode and policy, say which pairs of leaves could take a
> dual-homed server on the same port number, and tell me whether the fabric's vPC settings and
> the leaves' current vPC state allow it today.

*15 turns, 45 s. leaf1 had 56 free ports and leaf2 53, enough matching numbers for four servers,
and the border's free ports were routed. A vPC-bonded server could not go in today: no vPC pair
was configured.*

### 9. Who changed what

> Summarise the configuration deployment history of DevNet_Fabric as an audit record. Per user:
> how many deployments, to which switches, over what time span. Per switch: the number of
> deployments, the entities touched most often, and every deployment that did not succeed, with
> its time, entity and the number of commands that failed. If the history returned is capped,
> tell me how many rows exist and how many you saw, and raise the limit before concluding
> anything about totals.

*15 turns, 81 s. It refused to call the history complete: the controller reported 200 rows, the
result budget let it see 64 at a time, and asking switch by switch reached 133 of the 200. Of
those, one push by `admin`, no failure. (This run predates 0.3.1, which asks the controller for
the newest rows first; before it, a capped history was the oldest rows.)*

### 10. Explain the design to a new engineer

> Explain how DevNet_Fabric is built, to a network engineer who knows VXLAN EVPN but has never
> seen this fabric. From the fabric settings, describe the underlay routing protocol and its
> area or level, the BGP AS and how route reflection is arranged, the replication mode and what
> it implies for multicast, the anycast gateway MAC, the address ranges for loopbacks and
> point-to-point links, and the MTU. Then tie it to the real devices: which switches play which
> role, and how the fabric connects to the outside. Keep it to one page, and mark anything you
> inferred instead of read.

*10 turns, 46 s. One page: OSPF area 0 underlay, BGP AS 65001, multicast replication, the
loopback and link ranges with an example address from each, MTU 9216, and the switches by role,
with every inference marked.*

### 11. What is the device that is not in the fabric?

> The controller sees a device cabled into DevNet_Fabric that is not a member of it. Find it from
> the links, then tell me everything the controller knows about it: its name, model and serial
> number, which switches and ports it is connected to, the state of those ports on the fabric
> side, and the policy applied to them. Then tell me what an engineer would have to decide
> before adding it to the fabric: the role it would take, judging by where it is cabled, and
> which fabric settings would govern it. Do not add it.

*12 turns, 58 s. `leaf4`, found from the two neighbour-only links: its serial and model, cabled
to Ethernet1/4 of both spines, and in no fabric's switch list. Judging by the cabling, it would
join as a leaf.*

### 12. Find the cause of a down link

> One or more fabric links in DevNet_Fabric are not up. For each: both ends, by switch and port;
> on each end the admin state, the operational state and its reason, the mode, the MTU and the
> policy applied; and whether the two ends agree. Then say which of these it most likely is: an
> administratively shut port, a cable or transceiver fault, a configuration mismatch between the
> ends, or a planned link that was never cabled. Give the evidence for your choice and name what
> you would need from the switch itself to be sure.

*15 turns, 51 s. Both down links run between leaf1 and leaf2 (Ethernet1/5 and 1/6), all four
ports administratively shut, everything else matching: an administratively shut port.*

### 13. How the two fabrics connect

> This controller has an EVPN fabric and an external fabric. Show me how they connect: the
> switches on each side, the ports, the state and MTU of both ends, and what the external
> fabric's device is (model, role, software). Compare the two fabrics' BGP AS numbers and say
> what kind of peering that implies. List anything about the hand-off that looks inconsistent
> between the two ends.

*14 turns, 39 s. One link, the border's Ethernet1/1 to the edge router's Ethernet1/1, up on both
ends. Inconsistent: routed on the fabric side and access on the edge side, and MTU 9216 against
1500. AS 65001 against 65010, so eBGP.*

## Write prompts

> **Deploying configures switches.** A `deploy_*` tool pushes configuration to switches in a
> running network. Turn write access on only where you would make the same change by hand, and
> try these prompts on a lab first. Cisco's DevNet sandbox is one.

Write access is off by default. Turn it on with `./setup` (answer *Read and write*), or put
`NDFC_MCP_ACCESS=write` in `.env` and run `docker compose up -d`; `/healthz` then says
`"access":"write"`. A client may keep the tool list it saw before: aimo 1.4.7 does, so its first
prompt after the switch can still see only the read tools. Ask again, and it sees them all.

Every prompt stands on its own: run one, look at the fabric, and run the next tomorrow in a new
conversation. Within a scenario keep the order; the *check* prompts change nothing and can be
run at any time. Scenarios 1 to 4 each build something, check it, take it off the switches and
delete it, so the fabric ends as it started; scenario 5 configures no switch; scenario 6 deploys
the whole fabric.

The controller chose the identifiers when a prompt left them out: VRFs got VNIs from 50000 and
VLANs from 2000, networks VNIs from 30000 and VLANs from 2300. The gateways are from the
documentation ranges (192.0.2.0/24, 198.51.100.0/24), which no real network uses. On the lab,
`leaf1` and `leaf2` are leaves, `leaf3` is the border, and the ports used are `Ethernet1/12` to
`Ethernet1/16`.

The prompts say "Use the ndfc tool server". Replace that with the name your client gives this
server (the server's slug in this environment is `own_ndfc`; the name your client shows may differ); the wording of the rest of each prompt stays.

### What makes a change prompt work here

- **Name every object and every switch.** The model changes only what you name, and the server
  tells it to.
- **Say the order.** Create, attach, deploy; to remove, detach, deploy, delete.
- **Deploy one thing at a time.** Each deploy tool waits until its switches have finished (up to
  a minute) and says how each ended. Two deployments to one switch at once can leave it out of
  sync.
- **Say when to stop.** "If either switch is not ok, stop before changing anything" turns a
  failed check into a report instead of a half-built tenant.
- **Ask for what the controller answered.** The answer then quotes the controller, not the
  model's idea of what happened.
- **Give port lists as one string.** `switchPorts` and `detachSwitchPorts` take comma-separated
  names with no spaces, for example `Ethernet1/15,Ethernet1/16`. A JSON array is refused.

### Scenario 1: A tenant on two leaves

One VRF and one routed network, on two leaves with one port each: the smallest change that
touches two switches.

#### 1a. Build

```text
Use the ndfc tool server, fabric DevNet_Fabric. Build a small tenant on two leaves.
1. Read list_switches. Use leaf1 and leaf2. If either one's status is not ok, stop and say so before changing anything.
2. Create the VRF KB_T1_VRF with the description "kb tenant one". Create the network KB_T1_WEB in that VRF, gateway 192.0.2.1/24, description "kb web".
3. Attach KB_T1_VRF to leaf1 and to leaf2. Attach KB_T1_WEB to leaf1 on Ethernet1/12 and to leaf2 on Ethernet1/12.
4. Deploy KB_T1_VRF, then KB_T1_WEB.
5. Report what the controller answered to each change, as a short list.
Touch no other object. If a step fails, stop and say what is already on the controller.
```

*15 turns, 70 s. Both created (VNI 50000 and 30000), four attachments `PENDING`, then each deploy
settled in 13 s with both leaves `DEPLOYED` (VLAN 2000 and 2300).*

*Run again on 2026-11-17: as written, except that 1a did not re-read list_switches first (both
leaves had read `ok` earlier in that session). The VRF and network were created (VNI 50001 and
30000, see 1d), four attachments went `PENDING`, and both deploys reached `DEPLOYED` in 13 s.*

#### 1b. Check

```text
Use the ndfc tool server, fabric DevNet_Fabric. Check the tenant KB_T1_VRF / KB_T1_WEB on leaf1 and leaf2, without changing anything.
1. Read list_vrf_attachments for KB_T1_VRF and list_network_attachments for KB_T1_WEB.
2. Report a table: switch, VRF state, VRF VLAN, network state, network VLAN, ports.
3. Read list_deploy_history for each of the two switches (limit 5) and say what the most recent deployments on each reported.
4. Say plainly whether the tenant is on the switches now, and if not, what is still pending.
```

*7 turns, 22 s. Both `DEPLOYED` on both leaves, nothing pending.*

*Run again on 2026-11-17: steps 1, 2 and 4 as written. Step 3 (list_deploy_history, limit 5, for
each leaf) was not run, so the history was not read per switch.*

#### 1c. Take it off the switches

```text
Use the ndfc tool server, fabric DevNet_Fabric. Take the tenant KB_T1_VRF / KB_T1_WEB off the switches.
1. Detach KB_T1_WEB from leaf1 and from leaf2, and deploy KB_T1_WEB.
2. Detach KB_T1_VRF from leaf1 and from leaf2, and deploy KB_T1_VRF.
3. Report what the controller answered to each change. If the VRF's deploy finds nothing pending, say so: the controller removes a VRF from a switch when its last network leaves that switch. Do not delete anything yet and touch no other object.
```

*18 turns, 74 s. Both off both leaves, which stayed In-Sync. The VRF's deploy found nothing
pending: when a VRF's last network leaves a switch, the controller removes the VRF there in the
same deployment. The answer pointed out the mismatch instead of hiding it.*

*Run again on 2026-11-17: as written. The VRF's deploy reported nothing pending, as the note above
says.*

#### 1d. Delete

```text
Use the ndfc tool server, fabric DevNet_Fabric. Finish removing the tenant.
1. Read the attachments of KB_T1_WEB and KB_T1_VRF. If any switch still shows them attached or PENDING, stop and report the states.
2. Otherwise delete the network KB_T1_WEB, then the VRF KB_T1_VRF.
3. Read list_vrfs and list_networks and confirm that neither is left.
```

*8 turns, 17 s. Nothing attached, both deleted, neither listed.*

*Run again on 2026-11-17 (0.3.1, write access, DevNet_Fabric), step by step by hand, so no turn
counts. Every step as written. The VRF got VNI 50001, not 50000, because `KB_APP_VRF` held 50000
at the time. The VRF's deploy after the detach reported nothing pending, as the note above
says. Delete succeeded with nothing attached.*

### Scenario 2: A layer-2 segment across three switches

A layer-2 network with no VRF and no gateway, on two leaves with a port each and on the border
with none, so the border carries the segment without connecting a host to it.

#### 2a. Build

```text
Use the ndfc tool server, fabric DevNet_Fabric. Stretch one layer-2 segment, with no VRF and no gateway, across three switches.
1. Read list_switches. Use leaf1, leaf2 and the border switch leaf3. Stop before any change if any of the three is not ok.
2. Create the network KB_L2_STRETCH as a layer-2-only network, VLAN 2350, description "kb l2 stretch".
3. Attach it to leaf1 on Ethernet1/13, to leaf2 on Ethernet1/13, and to leaf3 with no ports.
4. Deploy it, and report what the controller answered to each change.
Touch no other object.
```

*10 turns, 41 s. `DEPLOYED` on all three switches.*

*Run again on 2026-11-17: 2a did not re-read list_switches before the change (both leaves had
read `ok` earlier in that session). Otherwise as written.*

#### 2b. Check

```text
Use the ndfc tool server, fabric DevNet_Fabric. Without changing anything, read list_network_attachments for KB_L2_STRETCH and list_networks, and report each switch's state, VLAN and ports, and the VNI the controller gave the network. Say whether the segment is on all three switches.
```

*4 turns, 12 s. On all three, VNI 30000, VLAN 2350, a port on each leaf and none on the border.*

*Run again on 2026-11-17: 2b read the attachments but not list_networks, so the VNI came from the
attachment read only.*

#### 2c. Take it off the switches

```text
Use the ndfc tool server, fabric DevNet_Fabric. Detach KB_L2_STRETCH from leaf1, leaf2 and leaf3, then deploy it. Report what the controller answered. Do not delete it yet and touch nothing else.
```

*10 turns, 35 s. Three detaches accepted (`PENDING`), one deployment that finished.*

#### 2d. Delete

```text
Use the ndfc tool server, fabric DevNet_Fabric. Read the attachments of KB_L2_STRETCH. If any switch still shows it attached or PENDING, stop and report. Otherwise delete it, and confirm with list_networks that it is gone.
```

*5 turns, 12 s. Deleted. On the first try after the detach the controller refused with "Network deployed, detach and delete" while the network still read `DEPLOYED`. About 30 s later the attachments read `NA` and the same delete succeeded: wait and retry once before reporting a refusal.

*Run again on 2026-11-17: 2a to 2c, every switch `DEPLOYED` on VLAN 2350. The 2d
delete was refused once, as above, then succeeded after a 30 s wait.*

### Scenario 3: A three-tier application in one VRF

A web, an application and a database tier, each its own network and gateway in one VRF, over two
leaves. Two networks share leaf1's `Ethernet1/14` as a trunk, and the middle tier is also on
leaf2 with no ports. The build is thirteen changes in one prompt; the server waits for each
deployment before the model sends the next.

#### 3a. Build

```text
Use the ndfc tool server, fabric DevNet_Fabric. Lay out a three-tier application in one VRF over two leaves.
1. Read list_switches; use leaf1 and leaf2, and stop before any change if either is not ok.
2. Create the VRF KB_APP_VRF with VLAN 2260. In it create three networks: KB_APP_WEB, gateway 198.51.100.1/26, VLAN 2361; KB_APP_MID, gateway 198.51.100.65/26, VLAN 2362; KB_APP_DB, gateway 198.51.100.129/26, VLAN 2363.
3. Attach KB_APP_VRF to leaf1 and leaf2. Attach KB_APP_WEB and KB_APP_MID to leaf1 on Ethernet1/14. Attach KB_APP_DB to leaf2 on Ethernet1/14, and KB_APP_MID to leaf2 with no ports.
4. Deploy the VRF, then the three networks.
5. Report what the controller answered to each change, as one list.
Touch no other object. If a step fails, stop and say what is already on the controller.
```

*21 turns, 118 s. All thirteen changes succeeded; nothing but the four `KB_APP_` objects was
touched.*

#### 3b. Check

```text
Use the ndfc tool server, fabric DevNet_Fabric. Without changing anything, report the application KB_APP_VRF as one table: network, VNI, VLAN, gateway, and for each of leaf1 and leaf2 the attachment state and ports. Use list_networks, list_vrf_attachments and list_network_attachments. Say whether everything that was attached is DEPLOYED.
```

*5 turns, 13 s. Everything attached was `DEPLOYED`, the VRF on VLAN 2260 on both leaves.*

#### 3c. Take it off the switches

```text
Use the ndfc tool server, fabric DevNet_Fabric. Take the application off the switches, one network at a time.
1. For KB_APP_WEB, then KB_APP_MID, then KB_APP_DB: detach it from every switch it is attached to, and deploy it before you go on to the next one.
2. Then detach KB_APP_VRF from leaf1 and leaf2, and deploy it. If the controller refuses the leaf1 detach as "already in detached state", that is expected after step 1 (the last network's deployment removes the VRF there); continue with leaf2.
3. Report what the controller answered to each change.
Do not delete anything yet and touch nothing else.
```

*23 turns, 128 s. All off both leaves. The VRF's detach was refused on leaf1 (*already in
detached state*): the last network's deployment had already removed the VRF, as in 1c.*

#### 3d. Delete

```text
Use the ndfc tool server, fabric DevNet_Fabric. Read the attachments of KB_APP_VRF and its three networks. If anything is still attached, PENDING or OUT-OF-SYNC, stop and report it. Otherwise delete KB_APP_WEB, KB_APP_MID and KB_APP_DB, then KB_APP_VRF, and confirm with list_vrfs and list_networks that nothing named KB_APP_ is left.
```

*12 turns, 19 s. All four deleted; nothing named `KB_APP_` left.*

*Run again on 2026-11-17. A stale `KB_APP_VRF` from an earlier run (no attachments, no networks)
was on the controller before the run began. It was deleted, with the owner's agreement, so the
scenario started clean. 3a to 3d as written, in order, with the state read at the start of 3a and again before 3d. In 3c leaf1's VRF detach was refused as "already in
detached state" and leaf2's was accepted; the VRF's deploy then reported nothing pending, and
every attachment read `NA`.*

### Scenario 4: Move a server from one leaf to another

A server moves from leaf1 to leaf2 while its network stays on leaf1's other port.
`detach_network` with a port list takes out only those ports: the server checks that the
network is on that switch and carries those ports before it sends anything.

#### 4a. Build

```text
Use the ndfc tool server, fabric DevNet_Fabric. Set up a server's network on leaf1.
1. Read list_switches; use leaf1 and leaf2, and stop before any change if either is not ok.
2. Create the VRF KB_MOVE_VRF and the network KB_MOVE_NET in it, gateway 192.0.2.129/25.
3. Attach KB_MOVE_VRF to leaf1, and KB_MOVE_NET to leaf1 on Ethernet1/15 and Ethernet1/16.
4. Deploy the VRF, then the network, and report what the controller answered.
```

*13 turns, 65 s. Deployed on leaf1, VLAN 2300 on Ethernet1/15 and 1/16.*

#### 4b. Move the port

```text
Use the ndfc tool server, fabric DevNet_Fabric. Move the server on Ethernet1/15 from leaf1 to leaf2, keeping KB_MOVE_NET on leaf1's Ethernet1/16.
1. Read list_network_attachments for KB_MOVE_NET and note its ports on each switch.
2. Attach KB_MOVE_VRF to leaf2, and KB_MOVE_NET to leaf2 on Ethernet1/15.
3. Call detach_network for KB_MOVE_NET on leaf1 with detachSwitchPorts ["Ethernet1/15"], so the network stays attached to leaf1 on Ethernet1/16.
4. Deploy KB_MOVE_VRF and KB_MOVE_NET.
5. Report the ports on each switch before this step and as the controller has them now.
```

*13 turns, 64 s. Ethernet1/15 moved to leaf2; leaf1 kept Ethernet1/16; both `DEPLOYED`.*

#### 4c. Take it off the switches

```text
Use the ndfc tool server, fabric DevNet_Fabric. Detach KB_MOVE_NET from every switch it is attached to and deploy it; then detach KB_MOVE_VRF from every switch and deploy it. Report what the controller answered. If the VRF's deploy finds nothing pending, say so: the controller removes a VRF from a switch when its last network leaves that switch. Do not delete anything yet.
```

*17 turns, 59 s. Off every switch. The VRF's deploy had nothing to do, for the reason in 1c.*

#### 4d. Delete

```text
Use the ndfc tool server, fabric DevNet_Fabric. Read the attachments of KB_MOVE_NET and KB_MOVE_VRF. If anything is still attached or PENDING, stop and report it. Otherwise delete KB_MOVE_NET, then KB_MOVE_VRF, and confirm with list_vrfs and list_networks that both are gone.
```

*8 turns, 14 s. Both deleted.*

*Run again on 2026-11-17: 4a did not re-read list_switches before the change (both leaves had read
`ok` earlier in that session). 4b to 4d as written. In 4b the controller read back Ethernet1/16 on
leaf1 and Ethernet1/15 on leaf2, both on VLAN 2300.*

### Scenario 5: What is refused

Six changes that must not happen, tried one after another. Nothing is attached or deployed, so
this one is safe to run on any fabric.

#### 5. Six refusals

```text
Use the ndfc tool server, fabric DevNet_Fabric. Show me what is refused, without configuring any switch. For each attempt quote the error code and the message, and say whether anything was changed.
1. Create the VRF KB_GUARD_VRF and the network KB_GUARD_NET in it, gateway 192.0.2.193/26. Do not attach or deploy them.
2. Try each of these, one at a time:
   a. attach KB_GUARD_VRF to the switch spine1;
   b. delete KB_GUARD_VRF while KB_GUARD_NET still exists;
   c. create a VRF named management;
   d. create a network named KB_GUARD_BAD in the VRF NA, gateway 192.0.2.200/26;
   e. take Ethernet1/12 out of KB_GUARD_NET on leaf1, where the network is not attached;
   f. create KB_GUARD_VRF a second time.
3. Delete KB_GUARD_NET and KB_GUARD_VRF, and confirm with list_vrfs and list_networks that neither is left.
Deploy nothing and touch no other object.
```

*20 turns, 51 s. All six refused, nothing changed. The controller refused three
(`controller_refused_change`: a VRF on a spine, HTTP 409; deleting a VRF that still has a
network; a duplicate VRF, both HTTP 400). The server refused three before sending anything
(`invalid_arguments`: the reserved name `management`, a gateway in the VRF `NA`, and taking a
port out where the network is not attached). For (d) the model chose a gateway itself, because
the prompt did not give one.

*Run again on 2026-11-17: all six refused, nothing changed. Step (e) first failed on argument
type, because the port list was sent as an array; the string form `Ethernet1/12` gave the
refusal the prompt describes. Step (d) was given its gateway, so its refusal is the `NA` message
alone.*

### Scenario 6: Bring the whole fabric back in sync

NDFC's *Recalculate Config* and *Deploy Config* for the whole fabric: what you run when switches
show `Out-of-Sync`, or after they lost their configuration. It deploys to every switch that has
something pending.

#### 6a. Recalculate and deploy

```text
Use the ndfc tool server, fabric DevNet_Fabric. This configures every switch that is out of sync.
1. Read list_switches and get_fabric_overview, and report each switch's configuration status and whether it is reachable. If a switch of the fabric is unreachable, stop and say which.
2. Run recalculate_fabric_config, then read list_switches again and say which switches are out of sync now.
3. Run deploy_fabric_config once and report what the controller answered.
Create, attach, detach or delete nothing.
```

*10 turns, 36 s. Every switch was already In-Sync, so recalculate ("Config save is completed")
and deploy ("Configuration deployment completed.") had nothing to push. The first time, right
after the switches were rebuilt with their day-0 configuration, four were `Pending` and the
deploy ran past `NDFC_WRITE_TIMEOUT_MS`: `write_outcome_unknown`, then all `In-Sync` two minutes
later on their own. A later run, with the switches already `In-Sync`, had nothing to push and finished without the timeout.*

#### 6b. Check

```text
Use the ndfc tool server, fabric DevNet_Fabric. Without changing anything: read list_switches and list_deploy_history (limit 30). Report each switch's configuration status, and per switch how many recent deployments succeeded and failed, with the status description of each failure.
```

*4 turns, 18 s. All five In-Sync, no failure in the 30 newest deployment rows, two warnings on
leaf2.

*Run again on 2026-11-17: precheck found all five `ok` and `In-Sync`. Recalculate answered "Config
save is completed" and the deploy "Configuration deployment completed.", run once with no
timeout. All five stayed `In-Sync`. The newest rows I read were scenario 3's teardown on leaf1 and
leaf2, not this deploy, and 6b was not run this session.*
