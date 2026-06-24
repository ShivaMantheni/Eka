#!/bin/bash

# ==========================================================
# INDIVIDUAL TEST EXECUTION - ONE SPYTEST CALL PER TEST
# Each test runs independently with its own log directory
# Logs: ./logs/<DATE>/<TEST_NAME>/
#
# Usage:
#   ./batch_cli.sh                    # Run all tests
#   ./batch_cli.sh --list             # List available tests
#   ./batch_cli.sh --tests 1,5,10     # Run specific test numbers
# ==========================================================

DATE_DIR=$(date +%Y%m%d)
BASE_LOG="./logs/PalC-Sonic/${DATE_DIR}"

mkdir -p "${BASE_LOG}"

# ==========================================================
# TEST DEFINITIONS
# Format: TEST_NAME:TESTBED:TEST_FILE
# ==========================================================
declare -a TESTS=(
    # BGP Tests - 3RR Testbed
    "BGP_LINK_FLAP_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_link_flap.py"
    "BGP_DAEMON_RESTART_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_daemon_restart.py"
    "BGP_DAEMON_RESTART_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_daemon_restart.py"
    "BGP_ROUTE_REFLECTOR_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_route_reflector.py"
    "BGP_NEGATIVE_PASSWORD_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_negative_password.py"
    "BGP_NEGATIVE_NEXTHOP_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_negative_nexthop.py"
    "BGP_NEGATIVE_ASN_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_negative_asn.py"
    "BGP_LOOPBACK_NEG_UPDATESRC_IPV4:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv4_bgp_loopback_negative_updatesource.py"
    "BGP_ROUTE_REFLECTOR_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_route_reflector.py"
    "BGP_NEGATIVE_PASSWORD_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_negative_password.py"
    "BGP_NEGATIVE_ASN_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_negative_asn.py"
    "BGP_LOOPBACK_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_loopback.py"
    "BGP_LOOPBACK_NEG_UPDATESRC_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_loopback_negative_updatesource.py"
    "BGP_LINK_FLAP_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_link_flap.py"
    "BGP_INTERFACE_ROUTES_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_interface_routes.py"
    "BGP_INTERFACE_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_interface.py"
    "BGP_INTERFACE_EBGP_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_ipv6_bgp_interface_ebgp.py"
    "BGP_PORTCHANNEL_IPV6:./testbeds/testbed_vs_3rr.yaml:routing/bgp/test_portchannel_ipv6_bgp.py"

    # BGP IPv4 Feature Tests - 2 Node Testbed
    "BGP_IPV4_BASIC:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_ipv4_basic.py"
    "BGP_SVI_IPV4:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_svi_ipv4.py"
    #"BGP_PORTCHANNEL_IPV4:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_portchannel_ipv4.py"
    #"BGP_LOOPBACK_IPV4:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_loopback_ipv4.py"
    #"BGP_IPV4_BASIC_EBGP:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_ipv4_basic_ebgp.py"
    #"BGP_SVI_IPV4_EBGP:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_svi_ipv4_ebgp.py"
    #"BGP_PORTCHANNEL_IPV4_EBGP:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_portchannel_ipv4_ebgp.py"
    #"BGP_LOOPBACK_IPV4_EBGP:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_loopback_ipv4_ebgp.py"
    "BGP_EBGP_CONNECTED_STATIC_REDIST:./testbeds/dlink_2node.yaml:routing/BGP/test_bgp_ebgp_connected_static_redistribution.py"

    # BGP isCLI Best Path Tests - 2 Node
    "BGP_ISCLI_LOCALPREF:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp50_localpref_selection.py"
    "BGP_ISCLI_ASPATH:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp51_aspath_selection.py"
    "BGP_ISCLI_MED:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp52_med_selection.py"
    "BGP_ISCLI_IBGP_EBGP:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp55_ibgp_ebgp_selection.py"
    "BGP_ISCLI_ORIGIN_CODE:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp56_origin_code_selection.py"
    "BGP_ISCLI_ROUTER_ID:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp57_router_id_tiebreak.py"
    "BGP_ISCLI_NEXTHOP_REACH:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp58_nexthop_reachability.py"

    # BGP isCLI Capability Tests - 2 Node
    "BGP_ISCLI_CAP_NEGOTIATION:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp76_capability_negotiation.py"
    "BGP_ISCLI_EXTENDED_NEXTHOP:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp78_extended_nexthop.py"

    # BGP isCLI EVPN Tests - 2 Node
    "BGP_ISCLI_EVPN_TYPE5:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_evpn04_type5_routes.py"

    # BGP isCLI Peer Group Tests - 2 Node
    "BGP_ISCLI_PG_PKT_QUEUE:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp_pg16_pkt_queue.py"
    "BGP_ISCLI_PG_ALLOWAS_IN:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp_pg17_allowas_in.py"
    "BGP_ISCLI_PG_CONFLICT_DETECT:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp_pg18_conflict_detection.py"
    "BGP_ISCLI_PG_PASSIVE_MODE:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp_pg19_passive_mode.py"
    "BGP_ISCLI_PG_ROUTEMAP_OVERRIDE:./testbeds/dlink_2node.yaml:system/iscli_BGP/test_bgp_pg20_routemap_override.py"

    # PortChannel isCLI Tests - 2 Node
    "PORTCHANNEL_ISCLI_BASIC:./testbeds/dlink_2node.yaml:switching/iscli_PortChannel/test_interface_1_iscli_portchannel.py"
    #"PORTCHANNEL_ISCLI_REBOOT:./testbeds/dlink_2node.yaml:switching/iscli_PortChannel/test_interface_2_iscli_portchannel_Reboot.py"

    # VLAN isCLI Tests - 2 Node
    "VLAN_ISCLI_BASIC:./testbeds/dlink_2node.yaml:switching/iscli_Vlan/test_interface_1_iscli_vlan.py"
    "VLAN_ISCLI_IP:./testbeds/dlink_2node.yaml:switching/iscli_Vlan/test_interface_2_iscli_vlan_ip.py"
    #"VLAN_ISCLI_REBOOT:./testbeds/dlink_2node.yaml:switching/iscli_Vlan/test_interface_1_iscli_vlan_reboot.py"
    #"VLAN_ISCLI_IP_REBOOT:./testbeds/dlink_2node.yaml:switching/iscli_Vlan/test_interface_2_iscli_vlan_ip_reboot.py"

    # Hardware Interface Events - 1 Node
    "HW_INTF_ADMIN_UP_DOWN:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_1_iscli_events_admin_up_down_HW.py"
    "HW_INTF_DESCRIPTION:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_3_iscli_events_description_HW.py"
    "HW_INTF_VLAN_IP:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_2_iscli_vlan_ip_HW.py"
    "HW_INTF_MTU_CHANGE:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_2_iscli_events_mtu_change_HW.py"
    "HW_INTF_VLAN:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_1_iscli_vlan_HW.py"
    "HW_INTF_PORTCHANNEL:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_1_iscli_portchannel_HW.py"
    "HW_INTF_IPV6_ADDRESS:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_5_iscli_events_ipv6_address_HW.py"
    "HW_INTF_IP_ADDRESS:./testbeds/dlink_1node.yaml:system/iscli_Hardware/test_interface_4_iscli_events_ip_address_HW.py"

    # System Interface Events - 2 Node
    "SYS_INTF_ADMIN_UP_DOWN:./testbeds/dlink_2node.yaml:system/iscli_interface_events/test_interface_1_iscli_events_admin_up_down.py"
    "SYS_INTF_MTU_CHANGE:./testbeds/dlink_2node.yaml:system/iscli_interface_events/test_interface_2_iscli_events_mtu_change.py"
    "SYS_INTF_DESCRIPTION:./testbeds/dlink_2node.yaml:system/iscli_interface_events/test_interface_3_iscli_events_description.py"
    "SYS_INTF_IP_ADDRESS:./testbeds/dlink_2node.yaml:system/iscli_interface_events/test_interface_4_iscli_events_ip_address.py"
    "SYS_INTF_IPV6_ADDRESS:./testbeds/dlink_2node.yaml:system/iscli_interface_events/test_interface_5_iscli_events_ipv6_address.py"

    # System AAA - 1 Node
    "SYS_AAA_AUTH:./testbeds/dlink_1node.yaml:system/AAA/test_aaa_auth.py"

    # System NTP - 1 Node (requires setup)
    "SYS_NTP_ISCLI:./testbeds/dlink_1node.yaml:system/ntp/test_ntp_iscli.py"

    # Static Routing Tests - 1 Node
    "STATIC_SM_ISCLI_7:./testbeds/dlink_1node.yaml:routing/static/test_sm_iscli_7.py"
    "STATIC_ROUTE_BASIC:./testbeds/dlink_1node.yaml:routing/static/test_static_route_basic.py"
    "STATIC_ROUTE_BASIC_KLISH:./testbeds/dlink_1node.yaml:routing/static/test_static_route_basic_klish.py"
    "STATIC_ROUTE_BLACKHOLE:./testbeds/dlink_1node.yaml:routing/static/test_static_route_blackhole.py"
    "STATIC_ROUTE_MGMT_VRF_KLISH:./testbeds/dlink_1node.yaml:routing/static/test_static_route_mgmt_vrf_klish.py"
    "STATIC_ROUTE_VRF_KLISH:./testbeds/dlink_1node.yaml:routing/static/test_static_route_vrf_klish.py"
    "STATIC_IPV6_ROUTE_BASIC_1:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_route_basic_1.py"
    "STATIC_IPV6_NEGATIVE:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_negative.py"
    "STATIC_IPV6_BLACKHOLE:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_blackhole.py"
    "STATIC_IPV6_ECMP:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_ecmp.py"
    "STATIC_IPV6_SCALE:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_scale.py"
    "STATIC_IPV6_VRF:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_vrf.py"
    "STATIC_IPV6_MGMT_VRF:./testbeds/dlink_1node.yaml:routing/static/test_static_ipv6_mgmt_vrf.py"
)

# ==========================================================
# COMMAND-LINE ARGUMENT PARSING
# ==========================================================

show_usage() {
    echo "=============================================="
    echo " Individual Test Execution Script"
    echo "=============================================="
    echo ""
    echo "Usage:"
    echo "  $0                          # Run all tests"
    echo "  $0 --list                   # List available tests"
    echo "  $0 --help                   # Show this help"
    echo "  $0 --tests <numbers>        # Run specific tests by number"
    echo ""
    echo "Examples:"
    echo "  $0 --tests 1,5,10           # Run tests 1, 5, and 10"
    echo "  $0 --tests 1-5              # Run tests 1 through 5"
    echo "  $0 --tests 1,3-5,10         # Run tests 1, 3-5, and 10"
    echo ""
}

list_tests() {
    echo "=============================================="
    echo " Available Tests"
    echo "=============================================="
    local i=1
    for test in "${TESTS[@]}"; do
        IFS=':' read -r name testbed file <<< "$test"
        printf "%3d. %-40s [%s]\n" "$i" "$name" "$(basename $testbed .yaml)"
        i=$((i + 1))
    done
    echo ""
    echo "Total: ${#TESTS[@]} tests"
    echo ""
}

# Parse command-line arguments
SELECTED_TESTS=()
RUN_ALL=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --list|-l)
            list_tests
            exit 0
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        --tests|-t)
            if [[ -z "$2" ]]; then
                echo "ERROR: --tests requires argument"
                show_usage
                exit 1
            fi
            RUN_ALL=false
            IFS=',' read -ra RANGES <<< "$2"
            for range in "${RANGES[@]}"; do
                if [[ "$range" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    # Range: 1-5
                    start=${BASH_REMATCH[1]}
                    end=${BASH_REMATCH[2]}
                    for ((i=start; i<=end; i++)); do
                        SELECTED_TESTS+=($i)
                    done
                else
                    # Single number
                    SELECTED_TESTS+=($range)
                fi
            done
            shift 2
            ;;
        *)
            echo "ERROR: Unknown option $1"
            show_usage
            exit 1
            ;;
    esac
done

# Display selected tests
if [[ "$RUN_ALL" == "true" ]]; then
    echo "=============================================="
    echo " RUNNING ALL TESTS"
    echo " DATE : ${DATE_DIR}"
    echo " Total: ${#TESTS[@]} tests"
    echo "=============================================="
else
    echo "=============================================="
    echo " RUNNING SELECTED TESTS"
    echo " DATE : ${DATE_DIR}"
    echo " Selected Test Numbers:"
    for num in "${SELECTED_TESTS[@]}"; do
        echo "   Test $num"
    done
    echo "=============================================="
fi

# ==========================================================
# Helper function to check if test should run
# ==========================================================
should_run_test() {
    local test_num=$1

    if [[ "$RUN_ALL" == "true" ]]; then
        return 0  # Run
    fi

    # Check if test number is in selected list
    for selected in "${SELECTED_TESTS[@]}"; do
        if [[ "$selected" -eq "$test_num" ]]; then
            return 0  # Run
        fi
    done

    return 1  # Skip
}

# ==========================================================
# Function to run a single test
# ==========================================================
run_test() {
    local test_num=$1
    local test_name=$2
    local testbed=$3
    local test_file=$4

    local time_stamp=$(date +%H%M%S)
    local log_path="${BASE_LOG}/${test_name}/${time_stamp}"
    mkdir -p "${log_path}"

    echo ""
    echo "=============================================="
    echo " Test #${test_num}: ${test_name}"
    echo " Testbed  : ${testbed}"
    echo " Test File: ${test_file}"
    echo " Logs     : ${log_path}"
    echo "=============================================="

    # Special setup for NTP test
    if [[ "$test_name" == "SYS_NTP_ISCLI" ]]; then
        echo "Setting up NTP server..."
        sudo ./tests/system/ntp/setup_ntp_server.sh
        ./tests/system/ntp/verify_ntp_server.sh
        ./tests/system/ntp/fix_ntp_server.sh
        export NTP_ISCLI_VAR_FILE=./tests/system/ntp/vars_ntp_iscli_local.yaml
    fi

    ./bin/spytest --tryssh 1 \
      --testbed "${testbed}" \
      "${test_file}" \
      --logs-path "${log_path}" \
      --log-level debug \
      --skip-init-config \
      --ifname-type native \
      --syslog-check none \
      --get-tech-support none \
      --env SPYTEST_MODULE_CONFIG_SAVE_SKIP=1

    RC=$?
    echo ""
    echo "Test #${test_num} (${test_name}) completed with RC=${RC}"

    if [ ${RC} -ne 0 ]; then
        echo "WARNING: Test #${test_num} (${test_name}) failed. Continuing to next test."
    fi

    return ${RC}
}

# ==========================================================
# Main Test Execution Loop
# ==========================================================

TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

test_num=1
for test in "${TESTS[@]}"; do
    if should_run_test "$test_num"; then
        IFS=':' read -r name testbed file <<< "$test"
        TOTAL_TESTS=$((TOTAL_TESTS + 1))

        run_test "$test_num" "$name" "$testbed" "$file"
        RC=$?

        if [ ${RC} -eq 0 ]; then
            PASSED_TESTS=$((PASSED_TESTS + 1))
        else
            FAILED_TESTS=$((FAILED_TESTS + 1))
        fi
    else
        echo "Skipping Test #${test_num} - not selected"
        SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
    fi
    test_num=$((test_num + 1))
done

# ==========================================================
# Summary
# ==========================================================

echo ""
echo "=============================================="
echo " TEST EXECUTION COMPLETED"
echo "=============================================="
echo " Total Tests Run : ${TOTAL_TESTS}"
echo " Passed          : ${PASSED_TESTS}"
echo " Failed          : ${FAILED_TESTS}"
echo " Skipped         : ${SKIPPED_TESTS}"
echo " Logs Root       : ${BASE_LOG}"
echo "=============================================="

# ==========================================================
# Generate Dashboard
# ==========================================================

if [ ${TOTAL_TESTS} -gt 0 ]; then
    echo ""
    echo "=============================================="
    echo " Generating Dashboard"
    echo "=============================================="

    DASHBOARD_DIR="${BASE_LOG}/dashboard"
    mkdir -p "${DASHBOARD_DIR}"

    TIME_STAMP=$(date +%H%M%S)
    DASHBOARD_FILE="${DASHBOARD_DIR}/test_dashboard_${DATE_DIR}_${TIME_STAMP}.html"

    python3 dashboard/scripts/generate_graphical_dashboard.py \
        --log-root ${BASE_LOG} \
        --out ${DASHBOARD_FILE} \
        --name "Individual Tests - ${DATE_DIR}"

    echo "Dashboard available at:"
    echo "file://$(pwd)/${DASHBOARD_FILE}"

    # Copy to user directory
    USER_DASHBOARD_DIR="${HOME}/Dashboard/INDIVIDUAL_TESTS"
    mkdir -p "${USER_DASHBOARD_DIR}"
    cp "${DASHBOARD_FILE}" "${USER_DASHBOARD_DIR}/"

    echo "Dashboard copy saved to:"
    echo "file://${USER_DASHBOARD_DIR}/test_dashboard_${DATE_DIR}_${TIME_STAMP}.html"
fi

echo ""

# Exit with appropriate code
if [ ${FAILED_TESTS} -gt 0 ]; then
    exit 1
else
    exit 0
fi
