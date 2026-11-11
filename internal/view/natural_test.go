package view

import (
	"sort"
	"testing"
)

func TestNaturalCompare(t *testing.T) {
	in := []string{"shoot-10", "shoot-2", "shoot-1", "shoot-11", "shoot-3"}
	want := []string{"shoot-1", "shoot-2", "shoot-3", "shoot-10", "shoot-11"}
	got := append([]string(nil), in...)
	sort.Slice(got, func(i, j int) bool { return naturalCompare(got[i], got[j]) < 0 })
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("natural sort = %v, want %v", got, want)
		}
	}
}

func TestNaturalCompareCases(t *testing.T) {
	cases := []struct {
		a, b string
		want int // sign
	}{
		{"a2", "a10", -1},
		{"a10", "a2", 1},
		{"a2", "a2", 0},
		{"abc", "abd", -1},
		{"item", "item1", -1}, // shorter (no digits) before one with a trailing number
		{"v1.9", "v1.10", -1}, // multiple digit runs
		{"x9y", "x10y", -1},   // digits in the middle
		{"01", "1", -1},       // equal magnitude, byte order breaks the tie
		{"01b", "1a", 1},      // padding only decides when the rest ties
		{"node-2", "node-10", -1},
		{"", "a", -1},
	}
	for _, c := range cases {
		got := naturalCompare(c.a, c.b)
		sign := 0
		if got < 0 {
			sign = -1
		} else if got > 0 {
			sign = 1
		}
		if sign != c.want {
			t.Errorf("naturalCompare(%q, %q) sign = %d, want %d", c.a, c.b, sign, c.want)
		}
	}
}
