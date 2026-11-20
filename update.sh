#!/bin/sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# node version the build needs; nvm switches to it when the system node is older
NODE_VERSION=22
# the process name in ecosystem.config.cjs
PM2_APP=exchange-spam-triage

BUILD=false
for arg in "$@"; do
  case "$arg" in
    -build) BUILD=true ;;
  esac
done


echo -e "${GREEN}__________________________________________________________________________________${NC}"
echo -e "${GREEN}|                                                                                |${NC}"
echo -e "${GREEN}|  SFW Update Script to update your build from github - please dont modify ver: s5 |${NC}"
echo -e "${GREEN}|  NOTE: This is a modified version that builds the app and restarts it in pm2.  |${NC}"
echo -e "${GREEN}|________________________________________________________________________________|${NC}"
echo -e "${GREEN}....${NC}"

case "$(uname -sr)" in

   Darwin*)
     echo 'Detected Mac OS X'
     git pull
     chmod 700 update.sh
     ;;

   Linux*Microsoft*)
     echo 'Detected WSL'  # Windows Subsystem for Linux
     git pull
     chmod 700 update.sh
     ;;

   Linux*)
     echo -e "${GREEN}* Detected Linux so will set your permissions properly${NC}"
     USER=$(stat -c '%U' .)
     GROUP=$(stat -c '%G' .)
     chmod 644 update.sh
     echo -e "${YELLOW}* Pulling GIT Repository${NC}"

     OLD_HEAD=$(git rev-parse HEAD)
     if ! OUTPUT=$(git pull 2>&1); then
         echo "$OUTPUT"
         echo -e "${RED}* git pull failed; update aborted${NC}"
         exit 1
     fi
     echo "$OUTPUT"
     NEW_HEAD=$(git rev-parse HEAD)

     chown -R $USER:$GROUP *
     echo -e "${YELLOW}* Setting no access on GIT Repository${NC}"
     chown -R root:root .git*
     chmod -R 600 .git*
     echo -e "${YELLOW}* fixing update script${NC}"
     chown root:root update.sh
     chmod 744 update.sh

     # Return success when files below the supplied path changed in the pull.
     path_changed() {
         if git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- "$1"; then
             return 1
         fi
         return 0
     }

     if [ "$OLD_HEAD" = "$NEW_HEAD" ] && ! $BUILD && [ -f dist/index.js ]; then
         echo -e "${GREEN}* No changes; build and restart skipped (use ./update.sh -build to force them)${NC}"
         echo -e "${GREEN}* update complete OK${NC}"
         exit 0
     fi

     # The app needs a newer node than some servers have, so switch node version with nvm before building.
     export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
     if [ -s "$NVM_DIR/nvm.sh" ]; then
         . "$NVM_DIR/nvm.sh"
         if ! nvm use "$NODE_VERSION" >/dev/null 2>&1 && ! nvm install "$NODE_VERSION"; then
             echo -e "${RED}* nvm could not switch to node $NODE_VERSION; update aborted${NC}"
             exit 1
         fi
     fi
     NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
     if [ "${NODE_MAJOR:-0}" -lt "$NODE_VERSION" ]; then
         echo -e "${RED}* node $NODE_VERSION or newer is needed to build, found $(node -v 2>/dev/null || echo none); update aborted${NC}"
         exit 1
     fi
     echo -e "${YELLOW}* using node $(node -v)${NC}"

     if [ ! -d node_modules ] || path_changed package-lock.json; then
         echo -e "${YELLOW}* installing packages${NC}"
         if ! npm install; then
             echo -e "${RED}* npm install failed; update aborted, the running app was left alone${NC}"
             exit 1
         fi
     else
         echo -e "${GREEN}* packages unchanged; skipping npm install${NC}"
     fi

     echo -e "${YELLOW}* building the app${NC}"
     if ! npm run build; then
         echo -e "${RED}* build failed; update aborted, the running app was left alone${NC}"
         exit 1
     fi
     chown -R $USER:$GROUP dist node_modules

     # pm2 runs under the user "pm2" where there is one. A restart keeps the node interpreter the app was started with.
     echo -e "${YELLOW}* restarting $PM2_APP in pm2${NC}"
     PM2_PATH='command -v pm2 >/dev/null || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; };'
     if id pm2 >/dev/null 2>&1; then
         su - pm2 -c "$PM2_PATH pm2 restart $PM2_APP"
     else
         pm2 restart $PM2_APP
     fi
     if [ $? -eq 0 ]; then
         echo -e "${YELLOW}* $PM2_APP restarted${NC}"
     else
         echo -e "${RED}* pm2 could not restart $PM2_APP - check it now, the app may be down${NC}"
         echo -e "${RED}* if it was never started: pm2 start $(pwd)/ecosystem.config.cjs && pm2 save${NC}"
         exit 1
     fi

     echo -e "${GREEN}* update complete OK${NC}"
     ;;

   CYGWIN*|MINGW*|MINGW32*|MSYS*)
     echo 'detected MS Windows under MINGW shell'
     git pull
     chmod 700 update.sh
     ;;

   *)
     echo 'Other OS'
     git pull
     ;;
esac
