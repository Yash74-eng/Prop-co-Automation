#!/usr/bin/env bash
# ===================================================================
#  PropCo Outreach Automation - one-click start for Mac and Linux.
#
#  Double-click, or run:  ./start-propco.sh
#  Installs what it needs the first time, then opens the app.
# ===================================================================
set -u
cd "$(dirname "$0")"

echo
echo "  =========================================="
echo "   PropCo Outreach Automation"
echo "  =========================================="
echo

fail() {
  echo
  echo "  $1"
  echo
  echo "  Send whoever set this up a screenshot of this window."
  echo
  read -r -p "  Press Enter to close. " _
  exit 1
}

# ---------------------------------------------------------------- Node check
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed on this computer."
  echo
  echo "  It is free and takes about two minutes:"
  echo
  echo "    1. Go to https://nodejs.org/en/download"
  echo "    2. Download the button marked LTS"
  echo "    3. Run the installer, clicking Next until it finishes"
  echo "    4. Run this file again"
  echo
  command -v open >/dev/null 2>&1 && open "https://nodejs.org/en/download"
  read -r -p "  Press Enter to close. " _
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  Node.js is installed but too old. This needs version 20 or newer;"
  echo "  you have version $NODE_MAJOR."
  echo
  echo "  Download the LTS version from https://nodejs.org/en/download,"
  echo "  install it, then run this file again."
  echo
  read -r -p "  Press Enter to close. " _
  exit 1
fi
echo "  Node.js $NODE_MAJOR found. Good."
echo

# ------------------------------------------------------ already running?
if curl -s -o /dev/null --max-time 3 http://localhost:5173/api/health 2>/dev/null; then
  echo "  The app is already running. Opening it in your browser..."
  command -v open >/dev/null 2>&1 && open "http://localhost:5173"
  command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:5173"
  echo
  echo "  Close the other PropCo window first if you want to restart it."
  read -r -p "  Press Enter to close. " _
  exit 0
fi

# ------------------------------------------------------------- settings file
if [ ! -f ".env" ]; then
  echo "  First run: creating your settings file..."
  cp ".env.example" ".env"
  echo "  Done. The app works as-is."
  echo "  To switch on the optional Claude check later, put your key in the .env file."
  echo
fi

# ------------------------------------------------------------- dependencies
if [ ! -d "node_modules" ]; then
  echo "  First run: installing components. This takes a few minutes."
  echo "  You only ever wait for this once."
  echo
  npm install || fail "Something went wrong while installing. Check your internet connection."
  echo
fi

if [ ! -d "web/node_modules" ]; then
  echo "  Installing the screen components..."
  echo
  npm --prefix web install || fail "Something went wrong while installing."
  echo
fi

if [ ! -f "web/dist/index.html" ]; then
  echo "  Preparing the app screens..."
  echo
  npm run web:build || fail "Something went wrong while preparing the app screens."
  echo
fi

# ------------------------------------------------------------------- launch
echo "  Starting. Your browser will open in a few seconds."
echo
echo "  ------------------------------------------------------------"
echo "   KEEP THIS WINDOW OPEN while you use the app."
echo "   Closing it shuts the app down. That is how you stop it."
echo "  ------------------------------------------------------------"
echo

(
  sleep 6
  command -v open >/dev/null 2>&1 && open "http://localhost:5173"
  command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:5173"
) >/dev/null 2>&1 &

npm start

echo
echo "  The app has stopped."
read -r -p "  Press Enter to close. " _
