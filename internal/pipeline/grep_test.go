package pipeline

import (
	"reflect"
	"testing"
)

func TestParseGrep(t *testing.T) {
	cases := map[string][]GrepTerm{
		"":                 nil,
		"etcd":             {{Text: "etcd"}},
		"Etcd !Completed":  {{Text: "etcd"}, {Text: "completed", Not: true}},
		"  a   b ":         {{Text: "a"}, {Text: "b"}},
		`"api 0" !"x y"`:   {{Text: "api 0"}, {Text: "x y", Not: true}},
		`\!foo a\ b`:       {{Text: "!foo"}, {Text: "a b"}},
		"! a":              {{Text: "a"}},
		"a!b":              {{Text: "a!b"}},
		"!!x":              {{Text: "!x", Not: true}},
		`"unclosed phrase`: {{Text: "unclosed phrase"}},
		`say \"hi\"`:       {{Text: "say"}, {Text: `"hi"`}},
		"^web":             {{Text: "web", Prefix: true}},
		"ing$":             {{Text: "ing", Suffix: true}},
		"^Running$":        {{Text: "running", Prefix: true, Suffix: true}},
		"!^kube-":          {{Text: "kube-", Not: true, Prefix: true}},
		`"^a b$"`:          {{Text: "a b", Prefix: true, Suffix: true}},
		`\^a b\$ c\$$`:     {{Text: "^a"}, {Text: "b$"}, {Text: "c$", Suffix: true}},
		"^ $ ^$":           nil,
		"a^b$c":            {{Text: "a^b$c"}},
		"a | b c":          {{Text: "a"}, {Text: "b", Or: true}, {Text: "c"}},
		"a | !b | ^c$":     {{Text: "a"}, {Text: "b", Not: true, Or: true}, {Text: "c", Prefix: true, Suffix: true, Or: true}},
		"| a |":            {{Text: "a"}},
		"a | | b":          {{Text: "a"}, {Text: "b", Or: true}},
		`a|b \| "|"`:       {{Text: "a|b"}, {Text: "|"}, {Text: "|"}},
		"a ||":             {{Text: "a"}, {Text: "||"}},
	}
	for in, want := range cases {
		if got := ParseGrep(in); !reflect.DeepEqual(got, want) {
			t.Errorf("ParseGrep(%q) = %+v, want %+v", in, got, want)
		}
	}
}

func TestMatchGrep(t *testing.T) {
	cells := []string{"etcd-main-0", "Running", "kube-system"}
	cases := map[string]bool{
		"":                        true,
		"etcd running":            true,
		"etcd !running":           false,
		`"0 run"`:                 true, // a phrase across cells
		"^etcd":                   true,
		"^main":                   false,
		"-0$":                     true,
		"main$":                   false,
		"^running$":               true,
		"^runn$":                  false,
		"^kube-system$":           true,
		`"^0 running$"`:           false, // starts mid-cell
		`"^etcd-main-0 running$"`: true,
		"!^kube":                  false,
		"!^system":                true,
		"pending | running":       true,
		"pending | failed":        false,
		"pending | !failed":       true,
		"etcd pending | crash":    false,
		"etcd pending | ^r":       true,
		"^api | ^etcd -0$":        true,
		"^api | ^cert -0$":        false,
	}
	for in, want := range cases {
		if got := MatchGrep(ParseGrep(in), cells); got != want {
			t.Errorf("MatchGrep(%q) = %v, want %v", in, got, want)
		}
	}
}
