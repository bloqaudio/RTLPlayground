CC = gcc
CCFLAGS = -Wall -o
BUILDDIR = output

all: create_build_dir $(BUILDDIR)/injector $(BUILDDIR)/fileadder $(BUILDDIR)/httpd_sim\
	$(BUILDDIR)/crc_calculator $(BUILDDIR)/imagebuilder $(BUILDDIR)/rstp_test

$(BUILDDIR)/rstp_test: rstp_test.c ../rstp.c ../rstp.h
	gcc -I.. -Wall -o $@ rstp_test.c
	$@

create_build_dir:
	mkdir -p $(BUILDDIR)

clean:
	rm -rf $(BUILDDIR)

$(BUILDDIR)/injector: injector.c
	gcc $^ $(CCFLAGS) $@

$(BUILDDIR)/fileadder: fileadder.c
	gcc $^ $(CCFLAGS) $@

$(BUILDDIR)/crc_calculator: crc_calculator.c
	gcc $^ $(CCFLAGS) $@

$(BUILDDIR)/httpd_sim: httpd_sim.c httpd_sim.h
	gcc $< $(CCFLAGS) $@ -I/usr/include/json-c -ljson-c

$(BUILDDIR)/imagebuilder: imagebuilder.c
	gcc $^ $(CCFLAGS) $@
