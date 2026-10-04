#!/bin/sh

# THiNX worker builder library, sourced by ./builder.
#
# Kept apart from ./builder so builder.test.js can source these functions and
# run them against a stub `docker` without running the whole build script.
# ./builder runs under /bin/sh, which is busybox ash in the worker image, so
# keep this file to what both busybox ash and bash accept.
#
# SWARMBUILD_POLL_INTERVAL and SWARMBUILD_MAX_ITERATIONS exist for the tests;
# production leaves them unset.

randomstring()
{
    cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w ${1:-32} | head -n 1
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
	INFO=$(docker service ls | grep $UNIQUE_NAME)
	echo $INFO
	ITERATIONS=0

	# 15 seconds x 4 = 1 minute; 4 x 15 minutes (max build duration) = 60
	MAX_ITERATIONS=${SWARMBUILD_MAX_ITERATIONS:-60}
	RUNNING=true

	# write logs in background; should be killed later
	docker service logs $UNIQUE_NAME | tee -a "$LOG_PATH" &

	while $RUNNING
	do
		ITERATIONS=$((ITERATIONS+1))
		sleep "${SWARMBUILD_POLL_INTERVAL:-30}"

		DSTATUS=$(docker service ls | grep  $UNIQUE_NAME)
		echo "Current service status: $DSTATUS"

		if [[ ! -z "$(echo ${DSTATUS} | grep -q \"1/1\")" ]];
		then
			echo "Still running..."
		fi

		if [[ ! -z "$(echo ${DSTATUS} | grep -q \"task: non-zero exit\")" ]];
		then
			echo "[worker] Service task failure - non-zero exit found:"
			echo ${DSTATUS}
			docker service rm $UNIQUE_NAME
			RUNNING=false
		fi

		if [[ ! -z "$(echo $DSTATUS | grep -q \"0/0\")" ]];
		then
			echo "Build completed."
			# append service logs to catch THINX BUILD SUCCESSFUL phrase; serves to decide to extract OUTFILE laters
			docker service logs $UNIQUE_NAME | tee -a "$LOG_PATH"
			# might get cleaned a bit later, but how do we do that? tagging?
			docker service rm $UNIQUE_NAME
			RUNNING=false
		fi

		if [[ "$DSTATUS" == *"No such image"* ]];
		then
			echo "Service image failure."
			docker service rm $UNIQUE_NAME
			RUNNING=false
		fi

		if [[ "$DSTATUS" == *"invalid"* ]];
		then
			echo "Service configuration failure."
			docker service rm $UNIQUE_NAME
			RUNNING=false
		fi

		if [[ -z "$DSTATUS" ]];
		then
			echo "Service failure."
			RUNNING=false
		fi

		if [[ "$ITERATIONS" -ge "$MAX_ITERATIONS" ]];
		then
			echo "Build Timed Out, terminating service."
			docker service rm $UNIQUE_NAME
			RUNNING=false
		fi
	done
}


# Path of the platformio firmware image to deploy, for the project in $1.
pio_outfile()
{
	echo "$(pwd)/$(find . -name "*.bin" | head -n 1)"
}
