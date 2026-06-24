#!/usr/bin/env python3
"""
SM_ISCLI Failure Analysis Report Generator

This script analyzes SPyTest log directories and generates a comprehensive
failure analysis report in CSV format with error snippets from log files.

Author: Claude Code
Date: 2026-02-06

Usage:
    python3 generate_failure_analysis.py <log_root_directory> [output_csv]

Example:
    python3 generate_failure_analysis.py ./logs/SM_ISCLI_20260205
    python3 generate_failure_analysis.py ./logs/SM_ISCLI_20260205 failures.csv
"""

import os
import sys
import csv
import re
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Tuple


class FailureAnalyzer:
    """Analyzes SPyTest logs and generates failure reports"""

    def __init__(self, log_root: str):
        self.log_root = Path(log_root)
        self.failures = []

    def find_testcase_csvs(self) -> List[Path]:
        """Find all testcases.csv files in the log directory"""
        return list(self.log_root.glob("**/results_*_testcases.csv"))

    def parse_testcase_csv(self, csv_path: Path) -> List[Dict]:
        """Parse a testcases.csv file and extract failures"""
        failures = []

        try:
            with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    result = row.get('Result', '')
                    if any(fail_type in result for fail_type in
                           ['Fail', 'ConfigFail', 'EnvFail', 'SkipFail', 'TopoFail']):
                        failures.append({
                            'batch': csv_path.parent.parent.name,
                            'feature': row.get('Feature', ''),
                            'testcase_id': row.get('TestCase', ''),
                            'function': row.get('Function', ''),
                            'module': row.get('Module', ''),
                            'result': result,
                            'result_type': row.get('ResultType', ''),
                            'executed_on': row.get('ExecutedOn', ''),
                            'description': row.get('Description', ''),
                            'devices': row.get('Devices', ''),
                            'log_dir': csv_path.parent
                        })
        except Exception as e:
            print(f"Error parsing {csv_path}: {e}")

        return failures

    def extract_error_from_module_log(self, log_dir: Path, module_path: str) -> Tuple[str, str]:
        """Extract error snippet and log file path from module log"""

        # Find module log file
        module_name = Path(module_path).stem
        log_files = list(log_dir.glob(f"module_{module_name}*.log"))

        if not log_files:
            # Try alternate pattern
            log_files = list(log_dir.glob(f"*{module_name}*.log"))

        if not log_files:
            return "Log file not found", ""

        log_file = log_files[0]
        error_snippet = ""

        try:
            with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()

                # Look for failure indicators
                failure_patterns = [
                    r'Report\(Fail\s*,',
                    r'FAILED.*test_',
                    r'AssertionError',
                    r'Error:',
                    r'Exception:',
                    r'Traceback',
                    r'failed to give prompt',
                    r'not found in',
                    r'Configuration failed'
                ]

                # Scan last 500 lines for errors (most recent)
                relevant_lines = lines[-500:]
                error_lines = []

                for i, line in enumerate(relevant_lines):
                    for pattern in failure_patterns:
                        if re.search(pattern, line, re.IGNORECASE):
                            # Capture context (5 lines before and after)
                            start = max(0, i - 5)
                            end = min(len(relevant_lines), i + 6)
                            error_lines = relevant_lines[start:end]
                            break
                    if error_lines:
                        break

                if error_lines:
                    error_snippet = ''.join(error_lines).strip()
                    # Limit to 500 characters
                    if len(error_snippet) > 500:
                        error_snippet = error_snippet[:500] + "..."
                else:
                    # If no specific error found, get last few lines
                    error_snippet = ''.join(lines[-10:]).strip()
                    if len(error_snippet) > 500:
                        error_snippet = error_snippet[:500] + "..."

        except Exception as e:
            error_snippet = f"Error reading log: {e}"

        # Convert to absolute path by prepending base directory
        base_path = "/home/hp_test/Athira/Palc-sonic/sonic-mgmt/spytest/"
        absolute_log_path = base_path + str(log_file)

        return error_snippet, absolute_log_path

    def analyze_failures(self) -> List[Dict]:
        """Main analysis function"""
        print(f"Scanning log directory: {self.log_root}")

        # Find all testcase CSVs
        testcase_csvs = self.find_testcase_csvs()
        print(f"Found {len(testcase_csvs)} testcase result files")

        all_failures = []

        for csv_path in testcase_csvs:
            failures = self.parse_testcase_csv(csv_path)

            for failure in failures:
                # Extract error snippet from log
                error_snippet, log_file = self.extract_error_from_module_log(
                    failure['log_dir'],
                    failure['module']
                )

                failure['error_snippet'] = error_snippet
                failure['log_file'] = log_file

                all_failures.append(failure)

        print(f"Total failures found: {len(all_failures)}")
        return all_failures

    def generate_csv_report(self, output_file: str):
        """Generate CSV failure analysis report"""

        failures = self.analyze_failures()

        if not failures:
            print("No failures found!")
            return

        # Define CSV columns
        fieldnames = [
            'Batch',
            'Feature',
            'Test Case ID',
            'Test Function',
            'Module',
            'Result',
            'Result Type',
            'Executed On',
            'Description',
            'Devices',
            'Error Snippet',
            'Log File Path'
        ]

        # Write CSV
        with open(output_file, 'w', newline='', encoding='utf-8') as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()

            for failure in failures:
                writer.writerow({
                    'Batch': failure['batch'],
                    'Feature': failure['feature'],
                    'Test Case ID': failure['testcase_id'],
                    'Test Function': failure['function'],
                    'Module': failure['module'],
                    'Result': failure['result'],
                    'Result Type': failure['result_type'],
                    'Executed On': failure['executed_on'],
                    'Description': failure['description'],
                    'Devices': failure['devices'],
                    'Error Snippet': failure['error_snippet'],
                    'Log File Path': failure['log_file']
                })

        print(f"\n✓ Failure analysis report generated: {output_file}")
        print(f"  Total failures analyzed: {len(failures)}")

        # Print summary statistics
        self._print_summary(failures)

    def _print_summary(self, failures: List[Dict]):
        """Print summary statistics"""

        print("\n" + "="*60)
        print("FAILURE ANALYSIS SUMMARY")
        print("="*60)

        # Count by batch
        batch_counts = {}
        for f in failures:
            batch = f['batch']
            batch_counts[batch] = batch_counts.get(batch, 0) + 1

        print(f"\nFailures by Batch:")
        for batch, count in sorted(batch_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  {batch:<50} {count:>3}")

        # Count by result type
        result_counts = {}
        for f in failures:
            result = f['result']
            result_counts[result] = result_counts.get(result, 0) + 1

        print(f"\nFailures by Result Type:")
        for result, count in sorted(result_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  {result:<20} {count:>3}")

        # Count by feature
        feature_counts = {}
        for f in failures:
            feature = f['feature']
            feature_counts[feature] = feature_counts.get(feature, 0) + 1

        print(f"\nFailures by Feature:")
        for feature, count in sorted(feature_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
            print(f"  {feature:<30} {count:>3}")

        print("\n" + "="*60)


def main():
    """Main entry point"""

    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    log_root = sys.argv[1]

    if not os.path.exists(log_root):
        print(f"Error: Log directory not found: {log_root}")
        sys.exit(1)

    # Determine output filename
    if len(sys.argv) >= 3:
        output_file = sys.argv[2]
    else:
        # Auto-generate output filename
        log_dir_name = Path(log_root).name
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = f"{log_dir_name}_failure_analysis_{timestamp}.csv"

    # Run analysis
    analyzer = FailureAnalyzer(log_root)
    analyzer.generate_csv_report(output_file)

    print(f"\nDone! Open the CSV file to view detailed failure analysis.")


if __name__ == "__main__":
    main()
