# Prompts for ndfc-mcp

Longer questions than the five in the README: each needs several tools and some reasoning
across their results. Copy one, change the fabric and switch names to yours, and send it.

The first four were run on 2026-11-12 through Claude Code against Cisco's DevNet sandbox
(`DevNet_Fabric`, two spines, two leaves, one border). Each note says what it took and what it
found there; your fabric will answer differently. The rest use the same tools in the same ways
and have not been run.

## What makes a prompt work here

- **Name the fabric or the switch.** Without one, the assistant spends its first calls finding
  out which exist.
- **Say what to compare.** "Audit the MTU" is vague; "the two ends of every fabric link, against
  the fabric's MTU setting" is a check.
- **Ask for what it could not check.** The server only reads (unless it was given write access)
  and hides some things on purpose (configuration text, secrets). A good answer says which
  checks it could not make.
- **Ask it not to guess.** Lists are cut when they are long, and the alarm list is one page from
  the controller. "Do not report on ports you did not look at" keeps a partial answer honest.
- **Ask for a shape**: a table, a Mermaid diagram, an ordered checklist. It is easier to act on.

## Run on the sandbox

### 1. Reconstruct the topology

> Reconstruct the physical topology of DevNet_Fabric from the controller. Use the switch
> inventory for roles and the link list for connections. Give me: (1) a Mermaid `graph TD`
> diagram with one node per switch labelled "name (role)" and one edge per link labelled with
> both interface names; (2) a table of every leaf and border switch showing which spines it
> connects to; (3) anything that breaks a clean spine-leaf design: a leaf that does not reach
> every spine, a link the controller sees only as a discovered neighbour, a device that is cabled
> into the fabric but is not a member of it. Use only what the tools return, and say so if a
> result was truncated.

*6 turns, 34 s. It drew the diagram and found three things: a switch `leaf4` cabled to both
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

*12 turns, 62 s. All 50 alarms it could see were unused ports on one spine. It also said, without
being asked, that the controller had returned exactly one page of 50, so "no alarms on the other
switches" was not something it could claim — and it pointed at the two down leaf-to-leaf links,
which had no alarm on that page.*

### 3. Investigate out-of-sync switches

> Some switches in DevNet_Fabric are out of sync with the controller. Find out which ones, then
> for each: its role, its last five configuration deployments (what was deployed to, when, by
> whom, outcome, and whether any command failed), and whether its interfaces also show an
> out-of-sync state and which ones. Compare with one switch that IS in sync. Tell me what the
> out-of-sync switches have in common, what the data suggests changed, and what the tools cannot
> tell me (for example the pending configuration difference itself). End with a short, ordered
> checklist of what an engineer should do in the NDFC UI next. Do not propose that you make any
> change.

*16 turns, 90 s. Three switches (both leaves and the border) were out of sync, every one of their
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

*21 turns, 52 s. Every loopback was inside its range and no address was duplicated except the
anycast rendezvous-point address, which it recognised as intended. One failure: the border's
link to the external router had MTU 9216 on one end and 1500 on the other.*

## More, not yet run

### 5. Morning health brief

> Give me a morning brief for every fabric on this controller, one section per fabric: how many
> switches by role, how many are healthy and how many in sync, software versions in use and
> whether they are all the same, the raised alarms grouped by severity and by switch, and any
> configuration deployment that failed. Put the three things that most need attention at the top,
> each with the switch name and the evidence. If the alarm list looks like a single page, say so
> instead of treating it as complete.

### 6. Is the fabric ready for a change?

> Tomorrow I will add a new tenant to DevNet_Fabric: one VRF and two networks. Check whether the
> fabric is in a state to take that change, and tell me what I need to know first. Look at:
> whether every switch is reachable and in sync, and which are not; raised alarms on the leaves
> and the border; the VRFs and networks that already exist, with their VNIs and VLANs; and the
> fabric's settings for VRF and network VLAN ranges, VNI ranges and the VRF and network
> templates. Give me a go / no-go with reasons, the ranges my new VNIs and VLANs must come from,
> and the values already taken. Do not create anything.

### 7. Compare two switches that should be twins

> leaf1 and leaf2 in DevNet_Fabric are meant to be configured alike. Compare them. For the
> policies: which templates are applied to one and not the other, and which are applied to both
> a different number of times. For the interfaces: any port whose mode, MTU, allowed VLANs,
> admin state or policy differs between the two switches, by port name. Ignore differences that
> must exist (hostname, serial number, addresses, the far end of each uplink). Give me two short
> tables and one sentence saying whether I should worry.

### 8. Free ports for new servers

> I need to connect four new dual-homed servers in DevNet_Fabric. For every leaf, count the
> Ethernet ports that are free: admin up or down, operationally down, no neighbour discovered,
> no description, not a member of a port-channel and not an end of any fabric link. List the
> free ports per leaf with their current mode and policy, say which pairs of leaves could take a
> dual-homed server on the same port number, and tell me whether the fabric's vPC settings and
> the leaves' current vPC state allow it today.

### 9. Who changed what

> Summarise the configuration deployment history of DevNet_Fabric as an audit record. Per user:
> how many deployments, to which switches, over what time span. Per switch: the number of
> deployments, the entities touched most often, and every deployment that did not succeed, with
> its time, entity and the number of commands that failed. If the history returned is capped,
> tell me how many rows exist and how many you saw, and raise the limit before concluding
> anything about totals.

### 10. Explain the design to a new engineer

> Explain how DevNet_Fabric is built, to a network engineer who knows VXLAN EVPN but has never
> seen this fabric. From the fabric settings, describe the underlay routing protocol and its
> area or level, the BGP AS and how route reflection is arranged, the replication mode and what
> it implies for multicast, the anycast gateway MAC, the address ranges for loopbacks and
> point-to-point links, and the MTU. Then tie it to the real devices: which switches play which
> role, and how the fabric connects to the outside. Keep it to one page, and mark anything you
> inferred instead of read.

### 11. What is the device that is not in the fabric?

> The controller sees a device cabled into DevNet_Fabric that is not a member of it. Find it from
> the links, then tell me everything the controller knows about it: its name, model and serial
> number, which switches and ports it is connected to, the state of those ports on the fabric
> side, and the policy applied to them. Then tell me what an engineer would have to decide
> before adding it to the fabric: the role it would take, judging by where it is cabled, and
> which fabric settings would govern it. Do not add it.

### 12. Find the cause of a down link

> One or more fabric links in DevNet_Fabric are not up. For each: both ends, by switch and port;
> on each end the admin state, the operational state and its reason, the mode, the MTU and the
> policy applied; and whether the two ends agree. Then say which of these it most likely is: an
> administratively shut port, a cable or transceiver fault, a configuration mismatch between the
> ends, or a planned link that was never cabled. Give the evidence for your choice and name what
> you would need from the switch itself to be sure.

### 13. How the two fabrics connect

> This controller has an EVPN fabric and an external fabric. Show me how they connect: the
> switches on each side, the ports, the state and MTU of both ends, and what the external
> fabric's device is (model, role, software). Compare the two fabrics' BGP AS numbers and say
> what kind of peering that implies. List anything about the hand-off that looks inconsistent
> between the two ends.
