FROM eclipse-temurin:17-jdk AS sdk

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools

# Install Android SDK (cached layer)
RUN apt-get update && apt-get install -y wget unzip && \
    mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && \
    cd /tmp && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdtools.zip && \
    unzip -q cmdtools.zip && \
    mv cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest && \
    rm cmdtools.zip && \
    yes | sdkmanager --licenses > /dev/null 2>&1 && \
    sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools" && \
    apt-get clean

# Install Gradle (cached layer)
RUN wget -q https://services.gradle.org/distributions/gradle-8.5-bin.zip -O /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    ln -s /opt/gradle-8.5/bin/gradle /usr/local/bin/gradle && \
    rm /tmp/gradle.zip

# Copy project structure
WORKDIR /project
COPY build.gradle settings.gradle gradle.properties ./
COPY app/build.gradle app/build.gradle
COPY app/libs app/libs
COPY libs libs
COPY live2d live2d
COPY gradle gradle
COPY gradlew gradlew
RUN chmod +x gradlew && \
    ./gradlew --no-daemon dependencies 2>/dev/null || true

# Copy source
COPY app/src app/src

# Build
RUN ./gradlew assembleDebug --no-daemon

CMD ["cat", "app/build/outputs/apk/debug/app-debug.apk"]
