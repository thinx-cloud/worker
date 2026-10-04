#!/bin/sh

# THiNX worker builder library, sourced by ./builder.
#
# Kept apart from ./builder so builder.test.js can source these functions and
# run them against a stub `docker` without running the whole build script.
# ./builder runs under /bin/sh, which is busybox ash in the worker image, so
# keep this file to what both busybox ash and bash accept.
#
# SWARMBUILD_FIRST_POLL, SWARMBUILD_POLL_INTERVAL and SWARMBUILD_MAX_ITERATIONS
# exist for the tests; production leaves them unset.

randomstring()
{
    cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w ${1:-32} | head -n 1
}

# Seconds to wait before poll number $1 of the build service. The first poll
# comes quickly, so a short build is not held for a full interval; later
# polls stay at or under 30 s. Non-numeric overrides fall back to defaults.
swarmbuild_poll_delay()
{
	if [ "$1" -le 1 ] 2>/dev/null;
	then
		case "${SWARMBUILD_FIRST_POLL}" in
			''|*[!0-9]*) echo 5 ;;
			*) echo "${SWARMBUILD_FIRST_POLL}" ;;
		esac
	else
		case "${SWARMBUILD_POLL_INTERVAL}" in
			''|*[!0-9]*) echo 10 ;;
			*) echo "${SWARMBUILD_POLL_INTERVAL}" ;;
		esac
	fi
}

# Stops the background `docker service logs` writer started by swarmbuild.
swarmbuild_stop_logs()
{
	if [ -n "${SWARMBUILD_LOGS_PID}" ];
	then
		kill "${SWARMBUILD_LOGS_PID}" 2>/dev/null
		wait "${SWARMBUILD_LOGS_PID}" 2>/dev/null
		SWARMBUILD_LOGS_PID=""
	fi
}

# Ends a build service: stops the background log writer, appends the service
# log to $LOG_PATH (the 'THiNX BUILD SUCCESSFUL' phrase there decides whether
# the platform branch deploys an OUTFILE) and removes the service.
swarmbuild_finish()
{
	swarmbuild_stop_logs
	docker service logs "$UNIQUE_NAME" 2>&1 | tee -a "$LOG_PATH"
	docker service rm "$UNIQUE_NAME"
}

swarmbuild()
{
	#echo "Examining networks..."
	# docker network ls returns --network cz-kgr-thinx_internal \

	LOG_PATH=$3
	BUILD_IMAGE=$2
	WORKDIR=$1

	# nodemcu container has different startup command (build)
	if [[ ! -z "$(echo $BUILD_IMAGE | grep nodemcu)" ]]; 
	then
		BUILD_IMAGE="$BUILD_IMAGE build"
	fi

	FIND="\/mnt\/data\/"
	DEPLOY_PATH=/mnt/data/deploy
	REPOS_PATH=/mnt/data/repos

	# replaces /mnt/data with /mnt/gluster/thinx (or DATA_PATH if set) for Service init
	if [[ -z "${DATA_PATH}" ]]; 
	then
		DATA_PATH="\/mnt\/gluster\/thinx\/"
	fi
	
	WORKDIR=$(echo "$WORKDIR" | sed "s/$FIND/$DATA_PATH/")
	DEPLOY_PATH=$(echo "$DEPLOY_PATH" | sed "s/$FIND/$DATA_PATH/")
	REPOS_PATH=$(echo "$REPOS_PATH" | sed "s/$FIND/$DATA_PATH/")

	echo "WORKDIR: ${WORKDIR}"
	echo "DEPLOY_PATH: ${DEPLOY_PATH}"
	echo "REPOS_PATH: ${REPOS_PATH}"

	UNIQUE_NAME="thinx_build-$(randomstring 16)"

	SERVICE_COMMAND="docker service create \
	--restart-condition=none \
	--mount type=bind,source=/var/run/docker.sock,destination=/var/run/docker.sock \
	--container-label owner=thinx \
	--limit-cpu=1 \
	--replicas=1 \
	--reserve-memory=750MB \
	--name $UNIQUE_NAME \
	--mount type=bind,source=$WORKDIR,destination=/opt/workspace \
	--mount type=bind,source=$DEPLOY_PATH,destination=/mnt/data/deploy \
	--mount type=bind,source=$REPOS_PATH,destination=/mnt/data/repos \
	$BUILD_IMAGE"

	echo "$SERVICE_COMMAND"
	echo "Starting Build Service..."

	$SERVICE_COMMAND

	echo "» Extracting Docker Service Log:"
	INFO=$(docker service ls | grep -F -- "$UNIQUE_NAME")
	echo "$INFO"
	ITERATIONS=0

	# ~30 minutes in total: one quick first poll, then 10 s polls
	case "${SWARMBUILD_MAX_ITERATIONS}" in
		''|*[!0-9]*) MAX_ITERATIONS=180 ;;
		*) MAX_ITERATIONS=${SWARMBUILD_MAX_ITERATIONS} ;;
	esac

	# Outcome for the caller: complete | failed | gone | timeout.
	# swarmbuild returns 0 only for complete.
	SWARMBUILD_OUTCOME=""

	# Early service log, written in the background. A plain redirect (not a
	# pipeline) keeps $! the PID of `docker service logs` itself, so
	# swarmbuild_finish can stop it.
	docker service logs "$UNIQUE_NAME" >> "$LOG_PATH" 2>&1 &
	SWARMBUILD_LOGS_PID=$!

	while [ -z "$SWARMBUILD_OUTCOME" ]
	do
		ITERATIONS=$((ITERATIONS+1))
		sleep "$(swarmbuild_poll_delay "$ITERATIONS")"

		DSTATUS=$(docker service ls | grep -F -- "$UNIQUE_NAME")
		echo "Current service status: $DSTATUS"

		if [ -z "$DSTATUS" ];
		then
			# Removed from outside (or never created): no task to read, no log left.
			echo "Service failure."
			swarmbuild_stop_logs
			SWARMBUILD_OUTCOME=gone
			break
		fi

		if echo "$DSTATUS" | grep -q "1/1";
		then
			echo "Still running..."
		else
			# 0/1: the task is not running. That is also the state while the
			# image is pulled, so the task state decides whether it has ended.
			TASK_STATE=$(docker service ps "$UNIQUE_NAME" --no-trunc --format '{{.CurrentState}}|{{.Error}}' 2>/dev/null | head -n 1)
			case "$TASK_STATE" in
				Complete*)
					echo "Build completed."
					swarmbuild_finish
					SWARMBUILD_OUTCOME=complete
					break
					;;
				Failed*|Rejected*|Shutdown*|Orphaned*|Remove*)
					echo "[worker] Service task failure: ${TASK_STATE}"
					swarmbuild_finish
					SWARMBUILD_OUTCOME=failed
					break
					;;
				*)
					echo "Task state: ${TASK_STATE:-unknown}, waiting..."
					;;
			esac
		fi

		if [ "$ITERATIONS" -ge "$MAX_ITERATIONS" ];
		then
			echo "Build Timed Out, terminating service."
			swarmbuild_finish
			SWARMBUILD_OUTCOME=timeout
			break
		fi
	done

	[ "$SWARMBUILD_OUTCOME" = "complete" ]
}

# --- platformio environment selection ----------------------------------------
#
# thinx.yml and platformio.ini come from the user's repository, so they are
# only read here (sed/awk), never sourced or eval'd, and nothing but the
# environment name is printed. thinx.yml can carry devsec ssid/pass/ckey.

# Names of the [env:NAME] sections in platformio.ini $1, one per line. The
# shared [env] section and ;/# commented lines are not environments.
pio_ini_envs()
{
	[ -f "$1" ] || return 0
	tr -d '\r' < "$1" | sed -n 's/^[[:space:]]*\[env:\([^]]*\)\].*$/\1/p'
}

# Value of `platformio: environment:` in thinx.yml $1, read the way the
# platformio builder image reads it (builders/platformio-docker-build/cmd.sh
# parse_yaml): a direct child of the top-level platformio key, surrounding
# double quotes dropped, the last occurrence wins.
pio_yml_environment()
{
	[ -f "$1" ] || return 0
	awk '
		{ sub(/\r$/, "") }
		/^[ \t]*(#.*)?$/ { next }
		{ match($0, /^[ \t]*/); indent = RLENGTH }
		indent == 0 { inblock = ($0 ~ /^platformio[ \t]*:[ \t]*$/); child = -1; next }
		inblock {
			if (child < 0) child = indent
			if (indent == child && $0 ~ /^[ \t]*environment[ \t]*:/) {
				v = $0
				sub(/^[ \t]*environment[ \t]*:[ \t]*/, "", v)
				sub(/[ \t]+$/, "", v)
				if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
				value = v
			}
		}
		END { printf "%s", value }
	' "$1"
}

# True when $1 is safe to pass to `platformio run --environment` and to use as
# a path segment: ^[A-Za-z0-9_.-]{1,64}$, not "." or "..", no leading "-".
pio_env_name_valid()
{
	case "$1" in
		''|.|..|-*|*[!A-Za-z0-9_.-]*) return 1 ;;
	esac
	[ "${#1}" -le 64 ]
}

# Decides which platformio environment project dir $1 deploys, before
# anything is built. $2 is the project's thinx.yml (may be empty).
# Sets PIO_ENV (empty only when platformio.ini declares no [env:NAME]) and
# returns 0, or sets PIO_ENV_ERROR and returns 1.
#  - platformio.environment in thinx.yml wins (cmd.sh builds only that env);
#  - otherwise a single [env:NAME] is that env;
#  - otherwise several envs are refused: platformio would build them all and
#    there is no telling which image belongs on the device.
pio_resolve_env()
{
	PIO_ENV=""
	PIO_ENV_ERROR=""

	pio_configured=""
	if [ -n "$2" ];
	then
		pio_configured=$(pio_yml_environment "$2")
	fi

	pio_envs=$(pio_ini_envs "$1/platformio.ini")
	pio_env_count=$(printf '%s\n' "$pio_envs" | grep -c .)

	if [ -n "$pio_configured" ];
	then
		if ! pio_env_name_valid "$pio_configured";
		then
			PIO_ENV_ERROR="invalid platformio.environment in thinx.yml: use 1-64 of A-Z a-z 0-9 _ . - (not . or .., no leading -)"
			return 1
		fi
		PIO_ENV="$pio_configured"
		if [ "$pio_env_count" -gt 0 ] && ! printf '%s\n' "$pio_envs" | grep -qxF -- "$PIO_ENV";
		then
			echo "[platformio] WARNING: platformio.environment ${PIO_ENV} is not an [env:...] section of platformio.ini"
		fi
		return 0
	fi

	if [ "$pio_env_count" -gt 1 ];
	then
		PIO_ENV_ERROR="multi-env platformio.ini: set platformio.environment in thinx.yml"
		return 1
	fi

	if [ "$pio_env_count" -eq 1 ];
	then
		if ! pio_env_name_valid "$pio_envs";
		then
			PIO_ENV_ERROR="platformio.ini environment name is not usable: set platformio.environment in thinx.yml"
			return 1
		fi
		PIO_ENV="$pio_envs"
	fi

	return 0
}

# Firmware image to deploy for project dir $1 and the environment $2 chosen
# by pio_resolve_env: exactly $1/.pio/build/$2/firmware.bin. Only a project
# that declares no [env:NAME] at all (empty $2) falls back to the old search.
pio_outfile()
{
	if [ -n "$2" ];
	then
		echo "$1/.pio/build/$2/firmware.bin"
	else
		echo "$1/$(cd "$1" && find . -name "*.bin" | head -n 1)"
	fi
}
